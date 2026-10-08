import React, { useState } from "react";
import { Shell } from "../App.js";
import { ThemeProvider } from "../components/ThemeProvider.js";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type BoardColumn,
  type ControlPlaneToUi,
  type RunnerView,
  type ProviderLoginView,
  type SessionReminderView,
  type SessionView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { CommandPalette } from "../components/CommandPalette.js";
import { InboxView } from "../components/InboxView.js";
import { Rail } from "../components/Rail.js";
import type { RightPanelState } from "../components/RightPanel.js";
import { SearchPaletteContext } from "../components/search-palette-context.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import { viewFromPath, viewPath, type View, type ViewNavigation } from "../navigation.js";
import { sessionsDestination } from "../sessions-view-mode.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { useSessionsViewModeMemory } from "../use-sessions-view-mode-memory.js";
import { useSessionsViewToggleKey } from "../useSessionsViewToggleKey.js";
import "../styles.css";

/**
 * The Sessions list/board surface with the app's own mode glue (#527): the REAL toggle-key hook,
 * the REAL mode-memory hook, and a URL-reflecting navigation, so the spec exercises the same code
 * paths the shell runs. The view path rides in `?path=` because the harness page is not the SPA:
 * pushing a bare `/board` would make a reload fetch the production app instead of this fixture.
 */
const SCOPE = "sessions-board-e2e";
const fullShell = new URLSearchParams(location.search).has("full-shell");
const empty = new URLSearchParams(location.search).has("empty");
/** An orchestrator with four children and a session with three pending requests (#896). */
const threads = new URLSearchParams(location.search).has("threads");
const openAiThreadParent = new URLSearchParams(location.search).get("thread-provider") === "openai";
const reminderConflict = new URLSearchParams(location.search).get("reminder-conflict");
/** Sessions in the lifecycle states the archive label and Fork Conversation tell apart (#2214): a
 * running turn in a worktree, a finished session, and a control plane that stops before archiving. */
const lifecycle = new URLSearchParams(location.search).has("lifecycle");
const entryRegressions = new URLSearchParams(location.search).has("entry-regressions");
let entryHydrated = !new URLSearchParams(location.search).has("entry-cold");
const entrySessionWaiters: Array<() => void> = [];

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "board-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }],
  workspaces: [{ id: "workspace-1", name: "Wollipog", path: "/repo" }],
  connectedAt: 1,
  lastSeen: 1,
};

const providerLoginScenario = new URLSearchParams(location.search).has("provider-logins");
if (providerLoginScenario) {
  runner.providerLogins = [
    { operationId: "login_failed-first", accountId: "work", label: "Work",
      provider: "claude", status: "failed", expectsCode: false, startedAt: 1,
      error: "The provider did not confirm authentication." },
    { operationId: "login_active", accountId: "team", label: "Team",
      provider: "codex", status: "waiting_for_provider", expectsCode: false, startedAt: 2 },
  ];
}

function session(id: string, title: string, column: BoardColumn, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id,
    runnerId: runner.runnerId,
    workspaceId: "workspace-1",
    workspaceName: "Wollipog",
    agentId: "codex",
    agentName: "Codex",
    title,
    status: "idle",
    column,
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 10,
    lastEventAt: 10,
    messageCount: 1,
    preview: `Preview for ${title}`,
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    ...overrides,
  };
}

const sessions = [
  session("s-running", "Running Session", "running"),
  session("s-queued", "Queued Session", "queued"),
  session("s-review", "Review Session", "review"),
  session("s-archived", "Archived Session", "review", { archived: true }),
  // A pending approval renders inline card actions — the nested controls the long-press spec
  // must prove a held finger cannot trigger (#540).
  session("s-approval", "Approval Session", "input_required", {
    pendingApproval: {
      requestId: "req-approve-1",
      kind: "tool",
      title: "Run npm test",
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "deny" },
      ],
    } as never,
  }),
  session("s-snoozed", "Snoozed Session", "review", {
    status: "input_required",
    pendingApproval: {
      requestId: "approval-snoozed",
      kind: "tool",
      title: "Deploy at 3:30 PM?",
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "deny" },
      ],
    } as never,
  }),
];

if (threads) {
  // Recent instants, unlike the rest of the fixture: a family that reads as stalled would sort
  // among the stalled rows and say nothing about how a live thread orders.
  const now = Date.now();
  const orchestrated = (id: string, title: string, column: BoardColumn, overrides: Partial<SessionView> = {}) =>
    session(id, title, column, { parentSessionId: "s-orchestrator", agentName: "Claude Code", driver: "claude-code", ...overrides });
  sessions.push(
    session("s-orchestrator", "Ship the usage and cost overhaul", "running", {
      status: "running",
      agentName: openAiThreadParent ? "Codex" : "Claude Code",
      driver: openAiThreadParent ? "codex-app-server" : "claude-code",
      lastEventAt: now - 60_000,
      updatedAt: now - 60_000,
    }),
    orchestrated("s-child-600", "#600: Add the usage table", "running", { status: "running", lastEventAt: now - 120_000, updatedAt: now - 120_000 }),
    orchestrated("s-child-601", "#601: Link the cost source", "review", {
      status: "input_required", lastEventAt: now - 180_000, updatedAt: now - 180_000,
      pendingApproval: { requestId: "ask-601", kind: "question", title: "Keep protocol 105 or bump to 106?", options: [], questions: [] } as never,
    }),
    orchestrated("s-child-602", "#602: Roll the daily budget over", "done", { status: "completed", lastEventAt: now - 240_000, updatedAt: now - 240_000 }),
    // Old enough to read as stalled: with its lifecycle and attention pills that makes the
    // three-pill signals cluster the phone shape has to fit on one line (#916).
    orchestrated("s-child-603", "#603: Normalize the allowance window", "review", {
      status: "input_required", lastEventAt: now - 900_000, updatedAt: now - 900_000,
      pendingApproval: { requestId: "rm-603", kind: "permission", title: "Delete usage-view-model.old.ts",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "deny" }] } as never,
    }),
  );
  const approval = sessions.find((candidate) => candidate.id === "s-approval")!;
  approval.pendingApproval = {
    ...approval.pendingApproval!,
    additionalRequests: [
      { requestId: "ask-289", kind: "question", title: "Which measurement strategy?", options: [], questions: [] },
      { requestId: "test-289", kind: "permission", title: "Run pnpm test", ownerToolUseId: "verifier",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
    ],
  } as never;
  approval.attentionOwners = [{ requestId: "test-289", toolCallId: "verifier", resolved: true, name: "Verifier", role: "tester" }];
  const familyFollowUp = new URLSearchParams(location.search).get("family-follow-up");
  if (familyFollowUp === "review" || familyFollowUp === "controlled") {
    for (const child of sessions.filter((item) => item.parentSessionId === "s-orchestrator")) {
      if (familyFollowUp === "review") {
        child.status = "running";
        child.pendingApproval = null;
      } else if (child.pendingApproval) {
        child.pendingRequestOwners = { human: 0, orchestrator: 1,
          requests: [{ requestId: child.pendingApproval.requestId, owner: "orchestrator" }] };
      }
      child.attention = { version: 1, meaningfulAt: now, humanActions: [], acknowledgedRevision: null,
        result: child.id === "s-child-601" ? { revision: "family-result", at: now,
          owner: familyFollowUp === "controlled" ? "orchestrator" : "human" } : null };
    }
  }
}

if (fullShell) {
  for (const [index, value] of sessions.filter(value => !value.archived).entries()) {
    value.status = "input_required";
    value.eventEpoch = 7;
    value.pendingApproval = { requestId: `primary-${index}`, title: "Primary Request", options: [],
      additionalRequests: [{ requestId: `child-${index}`, ownerToolUseId: "fixture-child",
        title: `Exact Child Request ${index}`, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }] };
    if (value.id === "s-running") delete value.pendingApproval.additionalRequests;
  }
}

if (entryRegressions) {
  const orchestrator = sessions.find((value) => value.id === "s-approval")!;
  orchestrator.role = "orchestrator";
  orchestrator.parentControl = "questions_and_approvals";
  orchestrator.pendingApproval = {
    requestId: "async-question", kind: "question", title: "Choose the Release Target", async: true,
    options: [], questions: [{ id: "target", header: "Target", question: "Where should the release go?",
      options: [{ label: "Staging" }, { label: "Production" }], allowOther: true }],
    additionalRequests: [{ requestId: "worker-question", ownerToolUseId: "fixture-child", kind: "question",
      title: "Choose the Worker Check", options: [], questions: [{ id: "check", header: "Check",
        question: "Which check should the worker run?", options: [{ label: "Unit Tests" }, { label: "Browser Tests" }] }] }],
  };
  const standard = sessions.find((value) => value.id === "s-running")!;
  standard.role = "normal";
  const descendant = sessions.find((value) => value.id === "s-queued")!;
  descendant.parentSessionId = orchestrator.id;
}

// More sessions waiting on the user, so the rail's Sessions badge reaches two and three digits
// (#2110). Each is blocked the way a real one is: waiting on a pending request.
const moreBlocked = Number(new URLSearchParams(location.search).get("more-blocked") ?? 0);
for (let index = 0; index < moreBlocked; index += 1) {
  sessions.push(session(`s-waiting-${index}`, `Waiting Session ${index + 1}`, "input_required", {
    status: "input_required",
    updatedAt: Date.now(),
    lastEventAt: Date.now(),
    pendingApproval: { requestId: `waiting-${index}`, title: "Approve Command", options: [] } as never,
  }));
}

// Ten session groups on two machines (#2180): one with a 90-character name, two both named Docs
// Site, and one with a session waiting on the user beside a running one.
const groups = new URLSearchParams(location.search).has("groups");
const secondRunner: RunnerView = { ...structuredClone(runner), runnerId: "runner-2", hostname: "build-02", displayName: "Build Server 02" };
if (groups) {
  runner.displayName = "Studio Mac";
  const group = (index: number, workspaceName: string, runnerId = runner.runnerId, overrides: Partial<SessionView> = {}) =>
    session(`s-group-${index}`, `${workspaceName} Session`, "running", {
      runnerId,
      workspaceId: `workspace-group-${index}`,
      workspaceName,
      ...overrides,
    });
  sessions.push(
    group(1, "Platform Reliability — Incident Follow-Ups, Postmortem Actions and Platform Hardening 2026"),
    group(2, "Docs Site"),
    group(3, "Docs Site", secondRunner.runnerId),
    group(4, "Billing", runner.runnerId, { status: "running", title: "Move the billing buckets to terraform",
      updatedAt: Date.now(), lastEventAt: Date.now() }),
    group(5, "Billing", runner.runnerId, { workspaceId: "workspace-group-4", status: "input_required",
      pendingApproval: { requestId: "group-5", title: "Approve Command", options: [] } as never }),
    group(6, "Design System"),
    group(7, "Infrastructure", runner.runnerId, { title: "Plan the terraform state migration",
      updatedAt: Date.now(), lastEventAt: Date.now() }),
    group(8, "Marketing Site"),
    group(9, "Mobile App", secondRunner.runnerId),
  );
}

// The Board's Machine and Agent filters (#2201): two named machines whose agents include one each
// machine reports unavailable and one with a 70-character name, and 29 active sessions of which 10
// run Claude Code. Nothing is Done, so that column folds to a strip.
const filtersScenario = new URLSearchParams(location.search).has("filters");
if (filtersScenario) {
  runner.displayName = "Studio Mac";
  runner.agents = [
    { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true },
    { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true },
    { id: "research", name: "Research Agent With Extended Repository Context and Staging Credentials",
      command: "research", args: [], env: {}, driver: "acp", available: true },
    { id: "gemini", name: "Gemini CLI", command: "gemini", args: [], env: {}, driver: "acp", available: false,
      unavailableReason: "Gemini CLI is not installed on this machine." },
  ];
  secondRunner.displayName = "Build Server 02";
  secondRunner.agents = [
    { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true },
    { id: "aider", name: "Aider", command: "aider", args: [], env: {}, driver: "acp", available: false },
  ];
  const columns: BoardColumn[] = ["running", "input_required", "review"];
  for (let index = 0; index < 10; index += 1) {
    sessions.push(session(`s-claude-${index}`, `Claude Code Session ${index + 1}`, columns[index % 3]!, {
      agentId: "claude", agentName: "Claude Code", driver: "claude-code",
      ...(columns[index % 3] === "input_required"
        ? { status: "input_required", pendingApproval: { requestId: `claude-${index}`, title: "Approve Command", options: [] } as never }
        : {}),
    }));
  }
  for (let index = 0; index < 15; index += 1) {
    sessions.push(session(`s-build-${index}`, `Build Session ${index + 1}`, index % 2 === 0 ? "running" : "review", {
      runnerId: secondRunner.runnerId,
    }));
  }
}

// One card of every kind the Board draws (#2222): idle and running cards whose previews are raw
// markdown, a permission request whose agent names its options Always Allow, Allow and Reject, a
// question, a sign-in with two methods and a cancel, a running parent with four children, and an idle
// parent with four children, whose card draws no status badge, so its chip has the line to itself.
const cardsScenario = new URLSearchParams(location.search).has("cards");
if (cardsScenario) {
  const now = Date.now();
  const recent = (minutes: number) => ({ updatedAt: now - minutes * 60_000, lastEventAt: now - minutes * 60_000 });
  const claude = { agentId: "claude", agentName: "Claude Code", driver: "claude-code" as const };
  runner.agents.push({ id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true });
  sessions.splice(0, sessions.length,
    session("s-idle", "Draft the release notes for v0.31 and link every merged pull request from the milestone", "review", {
      ...recent(42),
      preview: "(27/27)\n- [ ] Visual review… [design tokens doc](https://example.com/design-tokens)\n- [x] **Contrast** checks",
    }),
    session("s-busy", "Migrate the usage tables to the new schema", "running", {
      ...claude, ...recent(1), status: "running",
      preview: "## Summary\n\nRan `pnpm test` — **312 passed**, 3 files changed.",
    }),
    session("s-permission", "Fix the flaky reconnect test", "input_required", {
      ...recent(3), status: "input_required",
      pendingApproval: {
        requestId: "req-permission",
        kind: "permission",
        title: "Run **pnpm test** in apps/web",
        context: { toolName: "Bash", input: "pnpm --filter web test -- --reporter=dot" },
        options: [
          { optionId: "always", name: "Always Allow", kind: "allow_always" },
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    }),
    session("s-question", "Choose the cache eviction policy", "input_required", {
      ...claude, ...recent(6), status: "input_required",
      pendingApproval: { requestId: "req-question", kind: "question", title: "Keep the LRU cache or switch to TTL expiry?", options: [], questions: [] },
    }),
    session("s-sign-in", "Summarize the open design issues", "input_required", {
      agentId: "opencode", agentName: "OpenCode", driver: "acp", ...recent(9), status: "input_required",
      pendingApproval: {
        requestId: "req-sign-in",
        kind: "authentication",
        title: "OpenCode needs you to sign in before it can continue.",
        options: [
          { optionId: "auth_1_method_1", name: "OpenCode Zen", description: "Sign in at opencode.ai in a browser, then return here.", kind: "allow_once" },
          { optionId: "auth_1_method_2", name: "GitHub Copilot", description: "Use a GitHub Copilot subscription through a device code.", kind: "allow_once" },
          { optionId: "auth_1_cancel", name: "Cancel sign-in", kind: "reject_once" },
        ],
      },
    }),
    session("s-parent", "Ship the usage and cost overhaul", "running", { ...claude, ...recent(2), status: "running", role: "orchestrator" }),
    session("s-child-1", "#600: Add the usage table", "running", { ...claude, ...recent(2), status: "running", parentSessionId: "s-parent" }),
    session("s-child-2", "#601: Link the cost source", "done", { ...claude, ...recent(30), status: "completed", parentSessionId: "s-parent" }),
    session("s-child-3", "#602: Roll the daily budget over", "done", { ...claude, ...recent(40), status: "completed", parentSessionId: "s-parent" }),
    session("s-child-4", "#603: Normalize the allowance window", "review", {
      ...claude, ...recent(12), status: "input_required", parentSessionId: "s-parent",
      pendingApproval: { requestId: "req-child-4", kind: "question", title: "Bump the protocol to 106?", options: [], questions: [] },
    }),
    session("s-idle-parent", "Plan the onboarding rewrite", "review", { ...claude, ...recent(20), role: "orchestrator" }),
    session("s-idle-child-1", "#610: Draft the welcome flow", "queued", { ...claude, ...recent(20), parentSessionId: "s-idle-parent" }),
    session("s-idle-child-2", "#611: Pick the sample project", "done", { ...claude, ...recent(50), status: "completed", parentSessionId: "s-idle-parent" }),
    session("s-idle-child-3", "#612: Record the setup video", "done", { ...claude, ...recent(55), status: "completed", parentSessionId: "s-idle-parent" }),
    session("s-idle-child-4", "#613: Name the first-run checklist", "review", {
      ...claude, ...recent(15), status: "input_required", parentSessionId: "s-idle-parent",
      pendingApproval: { requestId: "req-idle-child-4", kind: "question", title: "Keep the checklist to five steps?", options: [], questions: [] },
    }),
  );
}

if (lifecycle) {
  runner.protocolVersion = PROTOCOL_VERSION;
  for (const value of sessions) {
    if (value.id === "s-running") Object.assign(value, { status: "running", worktreePath: "/repo/.worktrees/running" });
    if (value.id === "s-review") Object.assign(value, { status: "completed", worktreePath: "/repo/.worktrees/review" });
  }
}

if (empty) sessions.splice(0);
// Nothing waits for input, so the phone Board opens on the next column with a card (#2216).
if (new URLSearchParams(location.search).has("no-input")) {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    if (sessions[index]!.column === "input_required") sessions.splice(index, 1);
  }
}

const reminders: SessionReminderView[] = [
  {
    reminderId: "reminder-s-snoozed",
    sessionId: "s-snoozed",
    scheduledFor: Date.now() + 86_400_000,
    timeZone: "UTC",
    originalExpression: "tomorrow",
    wakePolicy: "until_activity",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    reminderId: "reminder-s-review",
    sessionId: "s-review",
    scheduledFor: Date.now() - 60_000,
    timeZone: "UTC",
    originalExpression: "one minute ago",
    wakePolicy: "regardless",
    state: "fired",
    revision: 2,
    createdAt: 1,
    updatedAt: Date.now() - 60_000,
    firedAt: Date.now() - 60_000,
    wakeReason: "scheduled",
  },
];

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: false,
      sessionReminders: true,
      indefiniteSessionReminders: true,
      ...(lifecycle ? { stopBeforeArchive: true } : {}),
    },
    runners: groups || filtersScenario ? [structuredClone(runner), structuredClone(secondRunner)] : [structuredClone(runner)],
    boxes: [],
    sessions: structuredClone(entryHydrated ? sessions : sessions.filter((value) => value.id !== "s-approval")),
    reminders: structuredClone(reminders),
    runs: [],
    pods: [],
  };
}

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let socket: FixtureSocket | null = null;
const connection: UiConnectionRuntime = {
  instanceId: SCOPE,
  runtimeKey: `${SCOPE}:1`,
  createSocket: () => {
    socket = new FixtureSocket();
    window.setTimeout(() => socket?.push(snapshot()), 0);
    return socket;
  },
  close() {},
};

declare global {
  interface Window {
    __setColumnCalls: Array<{ sessionId: string; column: BoardColumn }>;
    __approveCalls: string[];
    __reminderWriteCalls: number;
    __providerLoginCalls: string[];
    __publishProviderLogins: (logins: ProviderLoginView[]) => void;
    __replayProviderLoginSnapshot: () => void;
    __hydrateEntrySession: () => void;
    __updateEntrySession: (change: Partial<SessionView>) => void;
  }
}
window.__setColumnCalls = [];
window.__approveCalls = [];
window.__reminderWriteCalls = 0;
window.__providerLoginCalls = [];
window.__publishProviderLogins = logins => {
  runner.providerLogins = structuredClone(logins);
  socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
};
window.__replayProviderLoginSnapshot = () => socket?.push(snapshot());
window.__hydrateEntrySession = () => {
  entryHydrated = true;
  socket?.push(snapshot());
  for (const resolve of entrySessionWaiters.splice(0)) resolve();
};
window.__updateEntrySession = (change) => {
  const value = sessions.find((candidate) => candidate.id === "s-approval")!;
  Object.assign(value, change);
  socket?.push({ type: "session_upsert", session: structuredClone(value) });
};

const reconciledReminder: SessionReminderView = {
  ...reminders.find((candidate) => candidate.sessionId === "s-snoozed")!,
  scheduleKind: "timed",
  scheduledFor: new Date("2099-05-06T12:45:00.000Z").getTime(),
  timeZone: "Asia/Tokyo",
  originalExpression: "2099-05-06T21:45",
  wakePolicy: "until_activity",
  revision: 2,
  updatedAt: 2,
};

const client = {
  ...api,
  dismissProviderLoginNotice: async (runnerId: string, operationId: string) => {
    window.__providerLoginCalls.push(`dismiss:${operationId}`);
    const result = await api.dismissProviderLoginNotice(runnerId, operationId);
    runner.providerLogins = runner.providerLogins?.filter(login => login.operationId !== operationId);
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return result;
  },
  cancelProviderLogin: async (_runnerId: string, operationId: string) => {
    window.__providerLoginCalls.push(`cancel:${operationId}`);
    const login = runner.providerLogins?.find(login => login.operationId === operationId);
    if (!login) throw new Error("missing provider login");
    login.status = "cancelled";
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { login };
  },
  listSkills: async () => ({ skills: [] }),
  setColumn: async (sessionId: string, column: BoardColumn) => {
    window.__setColumnCalls.push({ sessionId, column });
    const moved = sessions.find((candidate) => candidate.id === sessionId);
    if (moved) {
      moved.column = column;
      window.setTimeout(() => socket?.push({ type: "session_upsert", session: structuredClone(moved) }), 0);
    }
  },
  approve: async (sessionId: string) => {
    window.__approveCalls.push(sessionId);
    const approved = sessions.find((candidate) => candidate.id === sessionId);
    if (!approved) throw new Error("session not found");
    approved.pendingApproval = null;
    window.setTimeout(() => socket?.push({ type: "session_upsert", session: structuredClone(approved) }), 0);
    return structuredClone(approved);
  },
  setReminder: async (_sessionId: string, request: import("@wollipog/protocol").SetSessionReminderRequest) => {
    window.__reminderWriteCalls++;
    if (reminderConflict !== null && window.__reminderWriteCalls === 1) {
      throw new ApiError("reminder changed in another client; reload and try again", 409);
    }
    return { ...reconciledReminder, ...request, revision: reconciledReminder.revision + 1, updatedAt: Date.now() };
  },
  sessionReminder: async () => ({
    reminder: reminderConflict === "removed" ? null : structuredClone(reconciledReminder),
  }),
  removeReminder: async (sessionId: string) => {
    const index = reminders.findIndex((reminder) => reminder.sessionId === sessionId);
    if (index >= 0) reminders.splice(index, 1);
    window.setTimeout(() => socket?.push({
      type: "session_reminder_removed",
      userId: "usr_local_owner",
      sessionId,
    }), 0);
    return { removed: true as const };
  },
  session: async (id: string) => {
    if (id === "s-approval" && !entryHydrated) await new Promise<void>((resolve) => { entrySessionWaiters.push(resolve); });
    const value = sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    return { session: structuredClone(value) };
  },
  ...(entryRegressions ? {
    sideChat: async (id: string) => ({ sideChat: {
      parentSessionId: id, createdAt: 1,
      session: session(`sidechat-${id}`, "Side Chat", "running", { status: "running" }),
    } }),
    descendantRequests: async () => ({ requests: [{
      sessionId: "s-queued", sessionTitle: "Queued Session", runnerId: runner.runnerId, runnerOnline: true,
      eventEpoch: 7, createdAt: 1, responseOwner: "human" as const, occurrenceId: "primary-1",
      request: structuredClone(sessions.find((value) => value.id === "s-queued")!.pendingApproval!),
    }] }),
    childSessions: async (_id: string, eventEpoch: number) => ({
      eventEpoch, children: [], attentionOwners: [], unidentifiedChildren: 0, nextAfter: null, truncated: false,
    }),
  } : {}),
  getSessionEventPage: async () => ({ events: [], hasOlder: false }) as never,
  getSessionEventTailPage: async () => ({ events: [], hasOlder: false }) as never,
  git: async () => ({}),
  gitSummary: async () => ({}),
  reviewFindings: async () => ({ findings: [], summary: {
    total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete",
  } }) as never,
} as unknown as ApiClient;

/** The harness page's own URL scheme: the SPA path rides in `?path=` (see the module note). */
const navigation: ViewNavigation = {
  current: () => {
    const path = new URLSearchParams(window.location.search).get("path") ?? "/";
    const url = new URL(path, window.location.origin);
    return viewFromPath(url.pathname, url.search) ?? { name: "inbox" };
  },
  push: (view) => {
    const url = new URL(window.location.href);
    url.searchParams.set("path", viewPath(view));
    window.history.pushState(null, "", url);
  },
  listen: (onView) => {
    const onPop = () => onView(navigation.current());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  },
};

const rightPanel = {
  open: false,
  mode: "launcher",
  width: 380,
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
} satisfies RightPanelState;

function HarnessShell() {
  const view = useStoreSelector((state) => state.view);
  const { navigate } = useStoreActions();
  // The same hooks the app shell mounts — the point of this harness is that these are not copies.
  useSessionsViewToggleKey(true, view, navigate);
  useSessionsViewModeMemory(view, SCOPE);
  // The shell's search palette, so Sessions' Search Transcripts opens it with its query (#2200).
  const [palette, setPalette] = useState<string | null>(null);
  return (
    <SearchPaletteContext.Provider value={(query) => setPalette(query ?? "")}>
    <div className="app">
      <Rail
        view={view}
        blockedCount={0}
        stalledCount={0}
        onNavigate={navigate}
      />
      <main className="main">
        <div className={`main-body${view.name !== "projects" ? " inbox-main-body" : ""}`}>
          {(view.name === "inbox" || view.name === "session" || view.name === "board") && (
            // The app's Sessions page container, so InboxView's page header lays out as it does there.
            <div className="page full fill">
              <InboxView
                viewMode={view.name === "board" ? "board" : "list"}
                expandedSessionId={view.name === "session" ? view.id : null}
                rightPanel={rightPanel}
                onOpenTerminal={() => {}}
                onCollapse={() => navigate(sessionsDestination(SCOPE))}
                onNewSession={() => {}}
                onOpenShortcuts={() => {}}
              />
            </div>
          )}
          {view.name === "projects" && <div className="fixture-projects">Projects Fixture</div>}
        </div>
      </main>
      {palette !== null && <CommandPalette initialQuery={palette} onClose={() => setPalette(null)} />}
    </div>
    </SearchPaletteContext.Provider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <InstanceScopeProvider instanceScope={SCOPE}>
      <ApiProvider client={client}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}>
            <ThemeProvider>{fullShell ? <Shell /> : <HarnessShell />}</ThemeProvider>
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>
    </InstanceScopeProvider>
  </React.StrictMode>,
);
