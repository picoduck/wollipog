import React from "react";
import { createRoot } from "react-dom/client";
import {
  ANTIGRAVITY_AGENT_ID,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type ControlPlaneToUi,
  type PendingApproval,
  type PermissionOption,
  type RunnerView,
  type SessionEvent,
  type SessionStatus,
  type SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "../components/SessionDetail.js";

/**
 * A Google Antigravity session (#4779) in the real SessionDetail, mounted by
 * transcript-states-e2e.html with `?scenario=antigravity`. Everything drawn here is the generic ACP
 * session UI; the fixture only gives it the shape real agy 1.5.14 reports (its model, thinking-level
 * and mode choices, its tool calls and permission options) and the statuses the runner's
 * Antigravity profile words (apps/runner/src/acp-compatibility.ts). `?agState=` picks one:
 *
 * - `pickers`: an idle session whose agent lists forty long model names (the fake agy's
 *   `session_many_models` stress shape), for the open Model Settings popover.
 * - `modes`: that idle session with agy's nine models, for the open Permission Mode menu, which
 *   names agy's four modes as agy does (`agentPermissionModes`).
 * - `streaming`: a running turn with a command's long output and a reply still streaming.
 * - `approval`: the turn waits on agy's permission request for `touch notes.txt`.
 * - `denied`: that request was denied, the tool call failed and the agent said so.
 * - `stopped`: the person stopped the turn (`turn_interrupted`, then idle).
 * - `install-failed`, `signin-failed`: the launch failed (`agent init failed: …`, status failed).
 * - `turn-failed`: the turn failed with a long provider quota message, capped as the runner caps it.
 *
 * Times are fixed; the evidence spec also fixes the clock and time zone. No real account appears:
 * agy's account is the runner's redaction placeholder `[account]`.
 */
const params = new URLSearchParams(window.location.search);
type AntigravityState = "pickers" | "modes" | "streaming" | "approval" | "denied" | "stopped" | "install-failed" | "signin-failed" | "turn-failed";
const state = (params.get("agState") ?? "pickers") as AntigravityState;

const SESSION_ID = "antigravity-session-e2e";
const NOW = Date.UTC(2026, 10, 21, 15, 30);
const STARTED = NOW - 2 * 60_000;
const AGENT_NAME = "Google Antigravity";

const REAL_MODELS: Array<[string, string]> = [
  ["gemini-4-neon", "Gemini 4 Neon"], ["gemini-4-argon", "Gemini 4 Argon"], ["gemini-4-hydrogen", "Gemini 4 Hydrogen"],
  ["orchestrator-neon", "Orchestrator (Neon)"], ["orchestrator-argon", "Orchestrator (Argon)"],
  ["gemini-3-8-flash", "Gemini 3.8 Flash"], ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"], ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
];
const STRESS_MODELS: Array<[string, string]> = Array.from({ length: 40 }, (_, index) =>
  [`fixture-model-${index + 1}`, `Fixture Model ${index + 1} With a Deliberately Long Display Name for Layout (Experimental Preview)`]);
const manyModels = state === "pickers";
const models = manyModels ? STRESS_MODELS : REAL_MODELS;
const currentModel = models[0]![0];

/** What acpSessionPresentation (apps/runner/src/acp-session-state.ts) makes of agy's session: its
 * `model` and `thought_level` options and its four modes, each approving through ACP permission. */
const permissionModes = ["default", "accept-edits", "auto", "plan"];
const capabilities: AgentCapabilities = {
  models: models.map(([id, displayName]) => ({ id, displayName, ...(id === currentModel ? { default: true } : {}) })),
  effortLevels: ["low", "medium", "high", "xhigh"],
  slashCommands: [],
  supportsImages: true,
  supportsApprovals: true,
  permissionModes,
  // agy's own names and meanings for its modes, as the runner forwards them.
  agentPermissionModes: [
    { id: "default", name: "Default", description: "Ask before edits and commands, per your permission settings." },
    { id: "accept-edits", name: "Accept edits", description: "Approve file edits in the workspace without asking." },
    { id: "auto", name: "Auto", description: "Approve edits and safe commands; ask before irreversible actions." },
    { id: "plan", name: "Plan", description: "Plan carefully before executing a task." },
  ],
  elicitation: Object.fromEntries(permissionModes.map((mode) => [mode, ["acp-permission" as const]])),
};

const launchFailed = state === "install-failed" || state === "signin-failed";
const runner = {
  runnerId: "runner-1",
  hostname: "fixture-workstation",
  displayName: "Fixture Workstation",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: ANTIGRAVITY_AGENT_ID,
    name: AGENT_NAME,
    command: "/home/fixture/.local/bin/agy",
    args: ["acp"],
    env: {},
    driver: "acp",
    context: { kind: "native" },
    source: "discovered",
    acpTransport: "stdio",
    version: "1.5.14",
    available: true,
    // A launch that needed sign-in reports the session's agent as signed out (acp.ts signInRequired).
    authStatus: state === "signin-failed" ? "unauthenticated" : "authenticated",
    capabilities: { ...capabilities, models: REAL_MODELS.map(([id, displayName]) => ({ id, displayName })), effortLevels: [] },
  }],
  workspaces: [{ id: "notes-app", name: "notes-app", path: "/home/fixture/projects/notes-app" }],
  connectedAt: NOW - 3_600_000,
  lastSeen: NOW,
  protocolVersion: PROTOCOL_VERSION,
} as unknown as RunnerView;

const allowDeny: PermissionOption[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];
const REQUEST_ID = "perm_1";
const pendingApproval: PendingApproval | null = state === "approval"
  ? { requestId: REQUEST_ID, title: "touch notes.txt", options: allowDeny, kind: "permission", requestedAt: STARTED + 30_000 }
  : null;

/** A command's output long enough to need its own scroll: a few thousand characters. */
const LONG_OUTPUT = [
  "total 184",
  ...Array.from({ length: 48 }, (_, index) =>
    `-rw-r--r--  1 fixture fixture ${String(1_200 + index * 37).padStart(6)} Nov 21 15:${String(index % 60).padStart(2, "0")} src/notes/module-${String(index + 1).padStart(2, "0")}-with-a-longer-file-name.test.ts`),
  "drwxr-xr-x  4 fixture fixture   4096 Nov 21 15:12 docs",
].join("\n");

/** The runner keeps 300 characters of a turn's provider reason, visibly cut (acpCompatibilityFailure). */
const QUOTA_DETAIL = ("Quota exhausted for [account]; try again later. The model provider rejected the request because the " +
  "daily request quota for this plan has been reached. Requests made with Gemini 4 Neon count toward the shared quota for " +
  "every Antigravity session that uses this sign-in. The quota resets at midnight Pacific time; retry after the reset, or " +
  "choose another model in Model Settings and send the message again.");
const QUOTA_REASON = QUOTA_DETAIL.length > 300 ? `${QUOTA_DETAIL.slice(0, 299).trimEnd()}…` : QUOTA_DETAIL;

const PROMPT = "Add a notes.txt file to the project root, then list the project files.";
const payloads: SessionEvent["payload"][] = [];
const prompt = (text = PROMPT) => payloads.push({ kind: "user_message", text, images: [] });
const touch = (status: string) => payloads.push({ kind: "tool_call", toolCallId: "call_touch", title: "touch notes.txt", toolKind: "execute", status });
switch (state) {
  case "pickers":
  case "modes":
    prompt("Summarize what this project does in two sentences.");
    payloads.push(
      { kind: "agent_thought", text: "Reading the README and package.json.", messageId: "thought-1", final: true },
      { kind: "agent_message", text: "This project is a small notes app: it stores plain-text notes in a folder and lists them in a web page.\n\nIt has a test suite for the storage layer and a script that builds the page.", messageId: "msg-1", final: true },
      { kind: "agent_response_completed" },
    );
    break;
  case "streaming":
    prompt("List the project files, then tell me which ones have tests.");
    payloads.push(
      { kind: "agent_thought", text: "Reading the request.", messageId: "thought-1", final: true },
      { kind: "tool_call", toolCallId: "call_ls", title: "ls -la src/notes", toolKind: "execute", status: "completed", text: LONG_OUTPUT },
      { kind: "agent_message", text: "The project has 48 test files under `src/notes`, one for each notes module. I'm now checking which modules", messageId: "msg-2" },
    );
    break;
  case "approval":
    prompt();
    touch("pending");
    payloads.push({ kind: "permission_request", requestId: REQUEST_ID, title: "touch notes.txt", options: allowDeny });
    break;
  case "denied":
    prompt();
    touch("pending");
    payloads.push(
      { kind: "permission_request", requestId: REQUEST_ID, title: "touch notes.txt", options: allowDeny },
      { kind: "permission_resolved", requestId: REQUEST_ID, optionId: "deny" },
      { kind: "tool_call_update", toolCallId: "call_touch", status: "failed" },
      { kind: "agent_message", text: "The command was denied, so nothing ran.", messageId: "msg-2", final: true },
      { kind: "agent_response_completed" },
    );
    break;
  case "stopped":
    prompt();
    payloads.push(
      { kind: "agent_thought", text: "Reading the request.", messageId: "thought-1", final: true },
      { kind: "agent_message", text: "I'll create notes.txt in the project root first, then", messageId: "msg-2" },
      { kind: "turn_interrupted" },
    );
    break;
  case "install-failed":
    payloads.push({ kind: "error", message: "agent init failed: Google Antigravity could not be started on this machine. Check its setup in Connections." });
    break;
  case "signin-failed":
    payloads.push({ kind: "error", message: "agent init failed: Google Antigravity needs sign-in on this machine. Sign in from Connections, then try again." });
    break;
  case "turn-failed":
    prompt();
    payloads.push(
      { kind: "agent_thought", text: "Reading the request.", messageId: "thought-1", final: true },
      { kind: "error", message: `Google Antigravity could not complete this turn: ${QUOTA_REASON}` },
    );
    break;
}
const events: SessionEvent[] = payloads.map((payload, index) => ({
  id: index + 1, sessionId: SESSION_ID, seq: index + 1, ts: STARTED + index * 15_000, payload,
}));

const statusByState: Record<AntigravityState, SessionStatus> = {
  pickers: "idle", modes: "idle", streaming: "running", approval: "input_required", denied: "idle", stopped: "idle",
  "install-failed": "failed", "signin-failed": "failed", "turn-failed": "idle",
};

const session = {
  id: SESSION_ID,
  runnerId: runner.runnerId,
  workspaceId: "notes-app",
  workspaceName: "notes-app",
  projectId: null,
  agentId: ANTIGRAVITY_AGENT_ID,
  agentName: AGENT_NAME,
  title: "Add a Notes File",
  status: statusByState[state],
  column: launchFailed ? "review" : state === "streaming" || state === "approval" ? "running" : "review",
  useWorktree: false,
  worktreePath: null,
  archived: false,
  createdAt: STARTED,
  updatedAt: events.at(-1)?.ts ?? STARTED,
  lastEventAt: events.at(-1)?.ts ?? STARTED,
  messageCount: events.length,
  eventEpoch: 0,
  preview: null,
  pendingApproval,
  driver: "acp",
  model: currentModel,
  effort: "high",
  permissionMode: "default",
  agentCapabilities: { ...capabilities, restartResumesConversation: false },
  ...(state === "streaming" || state === "approval" ? { activeTurnId: "turn-1" } : {}),
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  adopted: false,
} as unknown as SessionView;

const snapshotMessage: ControlPlaneToUi = {
  type: "snapshot",
  capabilities: { sessionSubscriptionsV2: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [runner],
  boxes: [],
  projects: [],
  sessions: [session],
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
  instanceId: "antigravity-session-e2e",
  runtimeKey: "antigravity-session-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: SESSION_ID }),
  push() {},
  listen: () => () => {},
};

const never = () => new Promise<never>(() => {});
const client = {
  ...api,
  session: never,
  getSessionEventPage: never,
  getSessionTurnStartPage: never,
  getSessionEventTailPage: (_id: string, _before: number | undefined, eventEpoch: number) =>
    Promise.resolve({ events, eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true }),
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
  expanded: false,
  setExpanded() {},
  setDragging() {},
  close() {},
  selectSubagent() {},
  showSubagent() {},
  consumeSubagentFocusRequest() {},
};

export function mountAntigravitySession(root: HTMLElement): void {
  createRoot(root).render(
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}>
        <div id="frame" style={{ height: "100vh", width: "100vw", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <SessionDetail
            sessionId={SESSION_ID}
            mode="expanded"
            rightPanel={rightPanel}
            onOpenTerminal={() => {}}
            composerDraftLoader={async () => null}
          />
        </div>
      </StoreProvider>
    </ApiProvider>,
  );
}
