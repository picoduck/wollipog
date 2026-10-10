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

/** Real-browser SessionDetail with a sign-in card (#1649, #2198), one scenario per state the
 * runner can put it in:
 * - `email` (default): signed in as a different account than the session uses (Use Current Account);
 * - `no-email`: the same, but the provider reports no email;
 * - `signed-out`: nobody is signed in and the runner can start a sign-in (Start Sign-In);
 * - `not-manager`: signed out, for a viewer who cannot manage the Machine;
 * - `readonly`: signed out, and the runner cannot start a sign-in here (Recheck Authentication);
 * - `methods`: an ACP agent (OpenCode) that offers several sign-in methods;
 * - `signing-in`: a sign-in the runner is running for this session, waiting for a pasted code;
 * - `older`: a pre-v180 runner that cannot report the signed-in account;
 * - `refused`: signed in as a different account, and the runner refuses another account as signed out,
 *   which the Machine's inventory then reports too;
 * - `not-resumable`: the same, but the conversation cannot continue under any other account;
 * - `removed`: the same, but the chosen account was removed from the Machine before the runner saw
 *   the choice (`account_unavailable`), and the dashboard has not heard yet;
 * - `none`: no other account is added to the Machine.
 * `?emailLabels=1` names two of the other accounts with an email, as people often do.
 * `__WOLLIPOG_AUTH_RECOVERY_E2E__.removeAccount(id)` removes an account from the Machine, as the
 * runner reports it, while the page is open.
 * `?theme=light|dark`, `?width=`, `?height=`. */
const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "email";
const frameWidth = Number(params.get("width") ?? "1100");
const frameHeight = Number(params.get("height") ?? "760");
const emailLabels = params.get("emailLabels") === "1";
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

declare global {
  interface Window {
    __WOLLIPOG_AUTH_RECOVERY_E2E__: {
      selections(): unknown[];
      decisions(): unknown[];
      /** Authorization codes submitted on the `signing-in` card, in order. */
      codes(): string[];
      identityRequests(): number;
      removeAccount(id: string): void;
      signOutAccount(id: string): void;
    };
  }
}

const SESSION_ID = "auth-recovery-e2e-session";
const STARTED = Date.now() - 4 * 60_000;
const CARD = "provider-auth:recovery-e2e";
const selections: unknown[] = [];
const decisions: unknown[] = [];
const codes: string[] = [];
let identityRequests = 0;
window.__WOLLIPOG_AUTH_RECOVERY_E2E__ = {
  selections: () => [...selections],
  decisions: () => [...decisions],
  codes: () => [...codes],
  identityRequests: () => identityRequests,
  removeAccount: (id) => {
    accountOptions = accountOptions.filter((account) => account.id !== id);
    runner.providerAccounts = runner.providerAccounts!.filter((account) => account.id !== id);
    socket?.onmessage?.({ data: JSON.stringify({ type: "runner_upsert", runner } satisfies ControlPlaneToUi) });
  },
  signOutAccount: (id) => {
    accountOptions = accountOptions.map((account) => account.id === id
      ? { ...account, authStatus: "unauthenticated", availability: "sign_in_required" } : account);
    runner.providerAccounts = runner.providerAccounts!.map((account) => account.id === id
      ? { ...account, authStatus: "unauthenticated" } : account);
    socket?.onmessage?.({ data: JSON.stringify({ type: "runner_upsert", runner } satisfies ControlPlaneToUi) });
  },
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
  }, {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    env: {},
    driver: "acp",
    available: true,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  canManage: scenario !== "not-manager",
  protocolVersion: scenario === "older"
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.providerAuthenticationAccountRecovery - 1
    : RUNNER_CAPABILITY_MIN_PROTOCOL.providerAuthenticationAccountRecovery,
  providerAccounts: [
    { id: "claude-work", label: "Work Subscription", provider: "claude", authStatus: "authenticated" },
    ...scenario === "none" ? [] : [
      { id: "claude-personal", label: emailLabels ? "jordan.personal@example.net" : "Personal Max", provider: "claude", authStatus: "authenticated" },
      { id: "claude-team", label: emailLabels ? "team.pilot@example.org" : "Team Pilot", provider: "claude", authStatus: "unauthenticated" },
      { id: "claude-lab", label: "Lab Sandbox", provider: "claude", authStatus: "unknown" },
    ],
  ],
  providerLogins: scenario === "signing-in" ? [{
    operationId: "login-e2e",
    accountId: "claude-work",
    label: "Work Subscription",
    provider: "claude",
    status: "awaiting_code",
    verificationUrl: "https://claude.ai/oauth/authorize?code=true",
    expectsCode: true,
    sessionId: SESSION_ID,
    startedAt: Date.now() - 30_000,
  }] : [],
} as unknown as RunnerView;

// The runner's options for each state (session-manager.ts `providerAuthenticationOptions`, and
// acp.ts `chooseAuthMethod` for an agent with several sign-in methods).
const OPTION = {
  acceptCurrent: {
    optionId: "auth:accept-current",
    name: "Use Current Account",
    description: "Explicitly accept the current authenticated state for this session only.",
    kind: "allow_once",
  },
  login: {
    optionId: "auth:login",
    name: "Start Sign-In",
    description: "Run the provider's login flow in this exact runner context. Output stays on the runner.",
    kind: "allow_once",
  },
  revalidate: {
    optionId: "auth:revalidate",
    name: "Recheck Authentication",
    description: "Ask the provider in this exact context whether authentication is now valid.",
    kind: "allow_once",
  },
  dismiss: {
    optionId: "auth:dismiss",
    name: "Dismiss Recovery",
    description: "Discard any retained prompt and make the session promptable without retrying provider work.",
    kind: "reject_once",
  },
  cancel: {
    optionId: "auth:cancel",
    name: "Cancel Sign-In",
    description: "Stop only this runner-owned provider sign-in attempt.",
    kind: "reject_once",
  },
} as const;
const methods = scenario === "methods";
const signedOut = scenario === "signed-out" || scenario === "not-manager" || scenario === "readonly";
const options = methods
  ? [
    { optionId: "auth_1_method_1", name: "OpenCode Zen", description: "Sign in at opencode.ai in a browser, then return here.",
      kind: "allow_once" },
    { optionId: "auth_1_method_2", name: "GitHub Copilot", description: "Use a GitHub Copilot subscription through a device code.",
      kind: "allow_once" },
    { optionId: "auth_1_method_3", name: "API key", description: "Read the provider API key from this machine's environment.",
      kind: "allow_once" },
    { optionId: "auth_1_cancel", name: "Cancel sign-in", kind: "reject_once" },
  ]
  : scenario === "signing-in"
  ? [OPTION.cancel]
  : scenario === "readonly"
  ? [OPTION.revalidate, OPTION.dismiss]
  : signedOut
  ? [OPTION.login, OPTION.revalidate, OPTION.dismiss]
  : [OPTION.acceptCurrent, OPTION.revalidate, OPTION.dismiss];

const reason = signedOut
  ? "Claude Code reported that no account is signed in."
  : "Provider account identity mismatch: email differed. Account values are redacted.";
const title = methods ? "Sign in to OpenCode"
  : scenario === "signing-in" ? "Signing In — Claude Code" : "Authentication Required — Claude Code";
const pendingApproval = {
  kind: "authentication" as const,
  requestId: methods ? "auth_1" : CARD,
  title,
  options,
  ...(methods ? {} : {
    context: {
      toolName: "Claude Code",
      input: [
        "Provider: Claude Code",
        "Machine: this native runner",
        scenario === "readonly"
          ? "Run `claude auth login` in that exact context, then recheck authentication."
          : "Run `claude auth login` in that exact context, or use Start Sign-In, then recheck authentication.",
        reason,
      ].join("\n"),
    },
  }),
};

const session = {
  id: SESSION_ID,
  runnerId: runner.runnerId,
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: methods ? "opencode" : "claude",
  agentName: methods ? "OpenCode" : "Claude Code",
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
  driver: methods ? "acp" : "claude-code",
  model: "claude-opus",
  effort: null,
  permissionMode: null,
  tokensIn: 4200,
  tokensOut: 1337,
  costUsd: 0.42,
  adopted: false,
  ...(methods ? {} : { providerAccountId: "claude-work", providerAccountLabel: "Work Subscription" }),
} as unknown as SessionView;

const events: SessionEvent[] = [
  { kind: "user_message", text: "Move the billing webhooks onto the new queue.", images: [] },
  { kind: "permission_request", requestId: pendingApproval.requestId, title: pendingApproval.title, options: pendingApproval.options,
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

let socket: FixtureSocket | null = null;
class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    socket = this;
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

let accountOptions: ProviderAuthenticationAccountOption[] = runner.providerAccounts!.map((account) => ({
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
        status: signedOut ? "unauthenticated" as const : "authenticated" as const,
        emailSupported: true,
        email: scenario === "no-email" || signedOut ? null : "morgan.lee@example.com",
        observedAt: Date.now() - 2 * 60_000,
      },
    };
  },
  authenticationAccounts: async () => ({ accounts: [...accountOptions] }),
  selectAuthenticationAccount: async (
    _id: string,
    input: { requestId: string; providerAccountId: string; expectedProviderAccountId: string },
  ) => {
    selections.push(input);
    if (scenario === "refused") {
      // The runner's recheck found the account signed out, and the Machine reports it so.
      window.__WOLLIPOG_AUTH_RECOVERY_E2E__.signOutAccount(input.providerAccountId);
      throw new ApiError(
        "The provider reports that this account is signed out. Sign in to it, then choose it again.",
        409,
        "sign_in_required",
      );
    }
    if (scenario === "not-resumable") {
      throw new ApiError("This provider conversation cannot resume under another account.", 409, "not_resumable");
    }
    if (scenario === "removed") {
      // Gone from the Machine before the runner saw the choice; the dashboard hears of it later.
      accountOptions = accountOptions.filter((account) => account.id !== input.providerAccountId);
      throw new ApiError(`That account cannot be used for this session: provider account '${input.providerAccountId}' ` +
        "is not configured.", 409, "account_unavailable");
    }
    return { accepted: true as const };
  },
  startProviderLogin: async () => ({}) as never,
  // The sign-in keeps waiting, so a capture shows the card the code was submitted from.
  submitProviderLoginCode: async (_runnerId: string, _operationId: string, code: string) => {
    codes.push(code);
    return {};
  },
  // The card stays as it is, so a capture shows what the person pressed rather than the next state.
  approve: async (_id: string, input: { requestId: string; optionId: string }) => {
    decisions.push(input);
    return session;
  },
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
    expanded: false,
    setExpanded: () => {},
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
