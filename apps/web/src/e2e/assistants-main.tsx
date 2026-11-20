import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type AgentHarnessDefaultsView,
  type AssistantDecisionDelegation,
  type AssistantThreadLimits,
  type AssistantThreadLaunchDefaults,
  type ControlPlaneToUi,
  type PendingApproval,
  type ProjectView,
  type RunnerView,
  type SessionConfig,
  type SessionEvent,
  type SessionNamingSettingsView,
  type SessionView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { Shell } from "../App.js";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { AssistantThread, AssistantThreadDefaults, CreateAssistantThreadRequest } from "../assistant-threads.js";
import type { AssistantOwnerConfirmation, AssistantThreadAccountChoices, ChangeAssistantThreadAccountRequest, OrchestratorCampaignBudgetDefault } from "@wollipog/protocol";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { assistantDecisionHistoryFixture } from "./assistant-decision-fixture.js";
import { ThemeProvider } from "../components/ThemeProvider.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import { viewFromPath, viewPath, type ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * The Assistants section (#4664) against a stub of the provisional Thread API shared with #4663.
 * This page is the only place the stub lives: the dashboard itself ships no fake threads.
 *
 * `?threads=owner-only` is a person who isn't an organization owner (every route answers 403),
 * `?threads=unavailable` is a control plane without the Thread API (every route answers 404),
 * `?threads=empty` one with no threads yet, `?threads=long` a dozen threads with titles at the
 * 120-character limit, and the default three threads, the first of which
 * launched two sessions, one of them waiting on a tool approval. The SPA path rides in `?path=`.
 * `window.assistantsAdvance()` finishes the running launched session, as its stream would.
 * `?confirm=N` (1–8) gives the first thread N owner confirmations waiting for its owner (#4665).
 * `?attention=N` gives the first thread a confirmation, the second a question, and extra threads confirmations (#4723).
 */
const SCOPE = "assistants-e2e";
const params = new URLSearchParams(location.search);
const scenario = params.get("threads") ?? "some";
const attentionCount = Number(params.get("attention") ?? 0);
const limitsScenario = params.get("limits");
const campaignScenario = params.has("campaign");
const delegationScenario = params.get("delegation");
const NOW = Date.now();
const minute = 60_000;
const accountScenario = params.get("accounts");
const fixtureAccountRef = (index: number) => `acct:${index.toString(16).padStart(16, "0")}`;
const fixtureAccounts: AssistantThreadAccountChoices["accounts"] = [
  { accountRef: fixtureAccountRef(1), label: "Studio Subscription" },
  { accountRef: fixtureAccountRef(2), label: "DesignResearchAndEngineeringSubscriptionForLongRunningProjectsAcrossTheEntireNorthAmericanWorkspace" },
  { accountRef: fixtureAccountRef(3), label: "Field Subscription", reason: "signed_out" },
  { accountRef: fixtureAccountRef(4), label: "Remote Subscription", reason: "context_incompatible" },
  { accountRef: fixtureAccountRef(5), label: "Metered Account", reason: "api_billing" },
  { accountRef: fixtureAccountRef(6), label: "Review Subscription", reason: "usage_exhausted" },
  { accountRef: fixtureAccountRef(7), label: "QA Subscription" },
  { accountRef: fixtureAccountRef(8), label: "Weekend Subscription" },
  { accountRef: fixtureAccountRef(9), label: "Release Subscription" },
];
const triageAccount = fixtureAccounts[accountScenario === "stress" ? 1 : 6]!;
const accountSelections = new Map([["thr_triage", triageAccount.accountRef]]);

function fixtureAccountChoices(harness: string, currentAccountRef?: string): AssistantThreadAccountChoices {
  const accounts = accountScenario === "stress" ? fixtureAccounts
    : accountScenario === "choices" ? [fixtureAccounts[0]!, ...fixtureAccounts.slice(2, 6)]
    : [fixtureAccounts[0]!, fixtureAccounts[6]!, fixtureAccounts[2]!];
  return harness === "codex"
    ? { accounts: [{ accountRef: fixtureAccountRef(10), label: "Codex Studio" }], policyAccountRef: fixtureAccountRef(10), currentAccountRef }
    : { accounts, policyAccountRef: fixtureAccountRef(1), currentAccountRef };
}

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "build-box",
  displayName: "Build Box",
  os: "linux",
  version: "1",
  status: "online",
  agents: [
    { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true },
    { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true },
  ],
  workspaces: [{ id: "workspace-1", name: "Wollipog", path: "/repos/wollipog" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
};

function session(id: string, title: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id,
    runnerId: runner.runnerId,
    workspaceId: "workspace-1",
    workspaceName: "Wollipog",
    projectId: null,
    agentId: "claude",
    agentName: "Claude Code",
    title,
    status: "idle",
    column: "review",
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: NOW - 40 * minute,
    updatedAt: NOW - 2 * minute,
    lastEventAt: NOW - 2 * minute,
    eventEpoch: 0,
    messageCount: 2,
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
    ...overrides,
  } as SessionView;
}

const sessions = new Map<string, SessionView>([
  ["sess-triage", session("sess-triage", "Triage Open Issues", { status: "idle" })],
  ["sess-release", session("sess-release", "Ship the Release Notes", { status: "running", agentId: "codex", agentName: "Codex", driver: "codex-app-server" })],
  ["sess-cleanup", session("sess-cleanup", "Weekly Cleanup", { status: "idle", updatedAt: NOW - 26 * 60 * minute })],
  ["sess-flaky", session("sess-flaky", "Fix the Flaky Upload Test", { status: "running", updatedAt: NOW - minute })],
  ["sess-deps", session("sess-deps", "Bump the Vite Group", {
    status: "input_required",
    pendingApproval: {
      requestId: "req-1",
      title: "Run pnpm install --frozen-lockfile",
      options: [
        { optionId: "allow", name: "Allow Once", kind: "allow_once" },
        { optionId: "reject", name: "Deny", kind: "reject_once" },
      ],
      kind: "permission",
    },
  })],
]);

const delegationProjects: ProjectView[] = delegationScenario === "stress" ? Array.from({ length: 36 }, (_, index) => ({
  id: `project_${index}`, name: index === 0 ? "Release Validation and Engineering " + "Dependencies".repeat(10) : `Project ${index}`,
  hidden: false, locations: [], activeSessionCount: 1, unarchivedSessionCount: 1, totalSessionCount: 1,
  createdAt: NOW, updatedAt: NOW,
})) : [];
for (const [index, project] of delegationProjects.entries()) {
  const id = `campaign_${index}`;
  sessions.set(id, session(id, `Release Campaign ${index}`, { role: "orchestrator", projectId: project.id }));
}

const question: PendingApproval = {
  kind: "question", requestId: "ask-release", title: "Release Scope", options: [],
  questions: [{ id: "scope", question: "Which release should I write up?", options: [{ label: "Next Release" }, { label: "Last Release" }] }],
};

if (attentionCount > 0) {
  for (const id of ["sess-triage", "sess-release", "sess-cleanup"]) {
    sessions.set(id, { ...sessions.get(id)!, role: "assistant" });
  }
}
if (attentionCount > 1) {
  sessions.set("sess-release", session("sess-release", "Ship the Release Notes", {
    role: "assistant", status: "input_required", pendingApproval: structuredClone(question),
  }));
}

const access = { level: "full_access", destructive: "ask" } as const;

/** `?confirm=N` (#4665): the first thread's assistant asked for N destructive commands (1–8) and waits
 * for its owner: stop a session it launched, archive another, then stop a third, and so on round the
 * three. Approve Once and Deny settle one and republish the thread. */
function confirmation(index: number): AssistantOwnerConfirmation {
  if (campaignScenario) return {
    id: `aoc_campaign_${index}`, threadId: "thr_triage", operation: "campaign_start", title: "Start Campaign",
    summary: "Starts an independent Orchestrator campaign with the settings and authority shown here. Its usage is charged to its own campaign allowance.",
    target: { kind: "project", id: "project-releases", label: index === 0
      ? "Release Engineering for Long-Running Cross-Platform Verification and Packaging · Build Machine"
      : "Release Engineering · Build Machine" },
    impact: [
      { label: "Campaign Mode", value: "Full Control" },
      { label: "Campaign Budget", value: "$20 USD · 150 tool calls" },
      { label: "Orchestrator Harness", value: "Codex (App Server)" },
      { label: "Orchestrator Model", value: "gpt-6.2-sol" },
      { label: "Orchestrator Effort", value: "high" },
      { label: "Child Harness", value: "Claude Code" },
      { label: "Child Model", value: index === 0
        ? "claude-opus-5-5-release-engineering-long-context-verification-preview-fixture"
        : "claude-opus-5-5" },
      { label: "Child Effort", value: "high" },
      { label: "Concurrent Children", value: "2" },
      { label: "Follow-Ups", value: "Recommend Only · 0 accepted follow-ups" },
      { label: "Completion", value: "Retain" },
      { label: "Provider Permissions", value: "Harness Default" },
      { label: "Isolation", value: "Strict Project Isolation off · Integration Isolation off" },
      { label: "Repository Scope", value: "example/release-tools · Release Engineering" },
      { label: "Initial Issues", value: "#38, #41" },
      { label: "Issue Authority", value: "Up to 2 issues. Related follow-ups require owner admission. Closure reasons: Completed." },
      { label: "Delegated Operations", value: "Issue Closure, Campaign Issue Scope, PR Merge, Merged Branch Deletion, Implementation Question, UI Evidence Approval" },
      { label: "Review", value: "Regular cross-model review." },
      { label: "Evidence", value: "The Orchestrator reviews screenshots. For video and external evidence it asks for screenshots." },
      { label: "Human-Required Gates", value: "Authentication and Credentials\nGovernance and Standing Access\nBudget Increases" },
    ],
    arguments: [{ label: "First Message", value: index === 0
      ? "Plan the release and check issues #38 and #41. Run the existing verification on the disposable Release Engineering project, then report the checks that passed and any fixes that need review. Match the results against ReleaseEngineeringCrossPlatformPackagingReadinessChecklistWithoutAdditionalSeparators."
      : `Audit the release checklist for issue #38. ${"LongUnbrokenReleaseChecklistIdentifier".repeat(20)}` }],
    campaign: { digest: index.toString(16).repeat(64), budget: { costUsd: 20, toolCalls: 150 } },
    status: "pending", createdAt: NOW - minute + index, expiresAt: NOW + 59 * minute, resolvedAt: null,
  };
  const stop = index % 3 !== 1;
  const [sessionId, label, worktree] = [["sess-flaky", "Fix the Flaky Upload Test", "flaky-upload"],
    ["sess-deps", "Bump the Vite Group", "bump-vite"], ["sess-release", "Ship the Release Notes", "release-notes"]][index % 3]!;
  return {
    id: `aoc_${index}_${sessionId}`, threadId: "thr_triage", operation: stop ? "session_stop" : "session_archive",
    title: stop ? "Stop Session" : "Archive Session",
    summary: stop ? "Stops the session and cancels its queued prompts and background jobs. Its transcript and worktree are kept, but it takes no further messages until it is restarted."
      : "Stops the session if it is running, then archives it and its side chat. Its transcript is kept, and it can be unarchived later.",
    target: { kind: "session", id: sessionId!, label: label! },
    impact: [{ label: "Status", value: "Running" }, { label: "Worktree Path", value: `/repos/wollipog/.worktrees/${worktree}` }],
    arguments: [{ label: "sessionId", value: sessionId! }],
    status: "pending", createdAt: NOW - minute + index, expiresAt: NOW + 59 * minute, resolvedAt: null,
  };
}
const confirmationCount = Math.min(8, Math.max(0, Number(params.get("confirm") ?? (attentionCount > 0 ? 1 : 0)) || 0));
function thread(id: string, sessionId: string, overrides: Partial<AssistantThread>): AssistantThread {
  const backing = sessions.get(sessionId)!;
  return {
    id, assistant: "wollipog", title: backing.title, harness: "claude-code", sessionId, status: "done", access,
    connectionId: `conn-${id}`, launchedSessionIds: [], lastActivityAt: backing.updatedAt, createdAt: backing.createdAt,
    ...(delegationScenario === "stress" || (limitsScenario && limitsScenario !== "old")
      ? { decisionDelegation: { revision: 0, grant: null } } : {}),
    ...(delegationScenario === "expires" ? { decisionDelegation: { revision: 1, grant: {
      categories: ["owner_question"], campaigns: "all", projects: "all", expiresAt: NOW + minute,
    } } } : {}),
    archivedAt: null, ...overrides,
  };
}

/** `?threads=long`: a dozen threads whose titles run to the control plane's 120-character limit, the
 * first being the triage thread with its launched work. */
const LONG_TITLES = [
  "Triage every open issue labelled flaky-test and fix what you can in the upload, terminal and session-list suites tonight",
  "Ship the release notes for 0.37 with a migration section for the new Assistant Thread API and every renamed setting",
  "WeeklyCleanupOfArchivedSessionsWorktreesAndOrphanedBranchesOnEveryRunnerIncludingTheOldBuildBoxThatNobodyUsesAnymore",
];
const longTitle = (index: number) => `${LONG_TITLES[(index - 1) % LONG_TITLES.length]!.slice(0, 116)} ${index}`;
const triage = (overrides: Partial<AssistantThread> = {}) =>
  thread("thr_triage", "sess-triage", { status: "needs_you", launchedSessionIds: ["sess-flaky", "sess-deps"], lastActivityAt: NOW - minute,
    ...(accountScenario ? { accountChangeSupported: true, providerAccountLabel: triageAccount.label } : {}),
    ...(confirmationCount > 0 ? { confirmations: Array.from({ length: confirmationCount }, (_unused, index) => confirmation(index)) } : {}),
    ...overrides });

let threads: AssistantThread[] = scenario === "long" ? [
  triage({ title: longTitle(1) }),
  ...Array.from({ length: 11 }, (_unused, index) => thread(`thr_long_${index + 2}`, index % 2 ? "sess-cleanup" : "sess-release", {
    title: longTitle(index + 2), status: index % 3 === 0 ? "working" : "done", lastActivityAt: NOW - (index + 2) * minute,
  })),
] : scenario === "some" ? [
  triage(),
  thread("thr_release", "sess-release", { status: attentionCount > 1 ? "needs_you" : "working", harness: "codex", lastActivityAt: NOW - 3 * minute }),
  thread("thr_cleanup", "sess-cleanup", { status: "done" }),
  // Archived: the list leaves it out, and a link to it opens it on its own.
  thread("thr_retired", "sess-cleanup", { title: "Retire the Old Runner", status: "archived", archivedAt: NOW - 2 * 24 * 60 * minute,
    lastActivityAt: NOW - 3 * 24 * 60 * minute }),
] : [];
if (delegationScenario === "many") {
  const grant: Omit<NonNullable<AssistantDecisionDelegation["grant"]>, "expiresAt"> = {
    categories: ["owner_question", "pr_merge"], campaigns: "all", projects: "all",
  };
  const future = NOW + 11 * 24 * 60 * minute;
  threads[0]!.decisionDelegation = { revision: 1, grant: { ...grant, expiresAt: future } };
  for (let index = 1; index <= 9; index += 1) {
    threads.push(thread(`thr_grant_${index}`, "sess-release", {
      title: index === 1 ? longTitle(index + 1) : `Delegated Release Review ${index}`,
      decisionDelegation: { revision: 1, grant: { ...grant, expiresAt: index % 2 ? NOW - minute : null } },
    }));
  }
}
for (let index = 2; index < attentionCount; index += 1) {
  const threadId = `thr_attention_${index}`;
  const sessionId = `sess_attention_${index}`;
  sessions.set(sessionId, session(sessionId, longTitle(index + 1), { role: "assistant" }));
  threads.push(thread(threadId, sessionId, {
    status: "needs_you", lastActivityAt: NOW - (index + 3) * minute,
    confirmations: [{ ...confirmation(0), id: `aoc_attention_${index}`, threadId }],
  }));
}

if (limitsScenario === "stress") {
  const current = threads[0]!;
  current.title = longTitle(1);
  for (let index = 3; index <= 40; index += 1) {
    const id = `sess-limit-${index}`;
    sessions.set(id, session(id, longTitle(index)));
    current.launchedSessionIds.push(id);
  }
}
if (limitsScenario) {
  for (const item of threads) {
    item.usage = {
      costUsd: { used: item.id === "thr_triage" ? 8.13 : 0, limit: 25 },
      launchedSessions: { used: item.launchedSessionIds.length, limit: limitsScenario === "stress" ? null : 10 },
    };
    if (item.status !== "archived" && limitsScenario !== "old") item.limitsEditable = true;
    if (item.id === "thr_triage" && limitsScenario === "budget") {
      item.launchLimitRefusal = "This Wollipog Assistant thread has spent or committed its whole $25 budget, so it cannot launch another session.";
    }
    const backing = sessions.get(item.sessionId);
    if (backing && limitsScenario !== "old") {
      backing.assistantThreadBudget = { threadId: item.id, limitUsd: item.usage.costUsd.limit };
      backing.costBudgetUsd = 15;
    }
  }
}

let limitDefaults: AssistantThreadLimits = { costUsd: 25, launchedSessions: 10 };
const defaults: AssistantThreadDefaults = {
  harness: "claude-code",
  harnesses: [
    { id: "claude-code", label: "Claude Code", available: true },
    { id: "codex", label: "Codex", available: true },
  ],
};
if (limitsScenario && limitsScenario !== "old") defaults.launchDefaults = { harness: "claude-code", providerAccount: null };
if (accountScenario || defaults.launchDefaults) {
  for (const harness of defaults.harnesses) {
    harness.accountSelection = { ...fixtureAccountChoices(harness.id), runnerId: "runner-1", workspaceId: "workspace-1" };
  }
}

let seq = 0;
const event = (sessionId: string, ts: number, payload: SessionEvent["payload"]): SessionEvent =>
  ({ id: ++seq, sessionId, seq, ts, payload }) as SessionEvent;
const events: Record<string, SessionEvent[]> = {
  "sess-triage": [
    // One whole turn, as a runner records it: the prompt, its checkpoint, the reply, and the turn's
    // usage and conversation checkpoint, which give the transcript's turn footer its finish time.
    event("sess-triage", NOW - 30 * minute, { kind: "user_message", text: "Last night's CI had two failures. Find out why and fix what you can.", images: [] }),
    event("sess-triage", NOW - 30 * minute + 1_000, { kind: "checkpoint", turn: 1 } as SessionEvent["payload"]),
    event("sess-triage", NOW - 29 * minute, {
      kind: "agent_message",
      text: "The upload test times out on slow runners, and the Vite group bump needs a fresh install. I started a session for each; the install is waiting for your approval.",
      final: true,
    }),
    event("sess-triage", NOW - 28 * minute, {
      kind: "token_usage", inputTokens: 3_200, cachedInputTokens: 41_000, cacheCreationInputTokens: 1_100, outputTokens: 820,
      costUsd: 0.21, durationMs: 118_000, model: "claude-opus-5-5",
    } as SessionEvent["payload"]),
    event("sess-triage", NOW - 28 * minute, { kind: "conversation_checkpoint", turn: 1 } as SessionEvent["payload"]),
  ],
};

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

/** A session as the live list carries it: a summary, whose waiting requests have no options. Only
 * `api.session` returns the detail, as the control plane's summary projection does. */
function summary(full: SessionView): SessionView {
  const pending = full.pendingApproval;
  return { ...structuredClone(full), projection: "summary",
    pendingApproval: pending ? { ...structuredClone(pending), options: [] } : null } as SessionView;
}

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptionsV2: false, boundedDelivery: false, paginatedSessionHistory: false,
      projects: delegationScenario === "stress", ...(delegationScenario === "stress" ? { assistantDecisionHistory: true as const } : {}) },
    projects: delegationProjects,
    runners: [structuredClone(runner)],
    boxes: [],
    // The launched sessions arrive as summaries; the backing sessions in full.
    sessions: [...sessions.values()].map((entry) => launched(entry.id) ? summary(entry) : structuredClone(entry)),
  } as UiSnapshotMessage;
}

let socket: FixtureSocket | null = null;
const connection: UiConnectionRuntime = {
  instanceId: SCOPE,
  runtimeKey: `${SCOPE}:1`,
  createSocket: () => {
    socket = new FixtureSocket();
    window.setTimeout(() => {
      socket?.onopen?.();
      socket?.push(snapshot());
    }, 0);
    return socket;
  },
  close() {},
};

function launched(id: string): boolean {
  return threads.some((candidate) => candidate.launchedSessionIds.includes(id));
}

function upsert(next: SessionView) {
  sessions.set(next.id, next);
  socket?.push({ type: "session_upsert", session: launched(next.id) ? summary(next) : structuredClone(next) } as ControlPlaneToUi);
}

/** `assistantsHoldNextList()`: the next list read answers with the threads as they were when it
 * began, but only once `assistantsReleaseList()` lets it, as a slow read would. */
let holdNextList = false;
let releaseHeldList: (() => void) | null = null;
let slowListMs = 0;

/** `?threads=unavailable`: the control plane's answer for routes it lacks. */
const unavailable = () => Promise.reject(new ApiError("not found", 404, undefined, { error: "not found" }));
/** `?threads=owner-only`: the person is not an organization owner. */
const OWNER_ONLY = "Only an organization owner can use Wollipog Assistant threads.";
const ownerOnly = () => Promise.reject(new ApiError(OWNER_ONLY, 403, undefined, { error: OWNER_ONLY }));
const refused = () => scenario === "unavailable" ? unavailable() : scenario === "owner-only" ? ownerOnly() : null;
const found = (threadId: string) => {
  const match = threads.find((candidate) => candidate.id === threadId);
  const message = "Assistant thread not found for this owner.";
  if (!match) throw new ApiError(message, 404, undefined, { error: message });
  return match;
};

function settleConfirmation(threadId: string, confirmationId: string, intent: "approve" | "deny") {
  const current = found(threadId);
  const asked = (current.confirmations ?? []).find((candidate) => candidate.id === confirmationId)!;
  const campaignId = asked.campaign && intent === "approve" ? `session_${asked.id}` : undefined;
  const confirmation: AssistantOwnerConfirmation = intent === "approve"
    ? { ...asked, status: "executed", resolvedAt: Date.now(), outcome: { receiptStatus: "succeeded", sessionId: campaignId } }
    : { ...asked, status: "denied", resolvedAt: Date.now(), outcome: { reason: "The owner denied it." } };
  document.body.dataset.confirmationAnswer = `${confirmationId}:${intent}`;
  const confirmations = (current.confirmations ?? []).filter((candidate) => candidate.id !== confirmationId);
  if (campaignId) upsert(session(campaignId, "Plan the Release", { role: "orchestrator", status: "running" }));
  const settled = { ...current, status: confirmations.length ? "needs_you" as const : "working" as const, confirmations,
    ...(campaignId ? { launchedCampaignIds: [...(current.launchedCampaignIds ?? []), campaignId] } : {}) };
  threads = threads.map((candidate) => candidate.id === threadId ? settled : candidate);
  publish(settled);
  return { confirmation: structuredClone(confirmation), thread: structuredClone(settled) };
}

/** The control plane publishes every thread change to its owner, as `assistant_thread_upsert`. */
function publish(changed: AssistantThread) {
  socket?.push({ type: "assistant_thread_upsert", userId: "usr_owner", thread: structuredClone(changed) } as ControlPlaneToUi);
}

const client = {
  ...api,
  assistantConfirmationThreads: () => refused() ?? Promise.resolve({
    threads: structuredClone(threads.filter((candidate) => candidate.status !== "archived")),
  }),
  agentHarnessDefaults: async (): Promise<AgentHarnessDefaultsView> => ({
    defaults: runner.agents.map((agent) => ({
      agentId: agent.id, driver: agent.driver ?? "claude-code", context: { kind: "native" }, name: agent.name,
      compatibleInstallations: 0,
      installations: [{ runnerId: runner.runnerId, machineName: runner.displayName ?? runner.hostname, online: true,
        models: [], effortLevels: [], permissionModes: ["default"] }],
    })),
  }),
  sessionNamingSettings: async (): Promise<SessionNamingSettingsView> => ({
    mode: "prompt_text_only", effectiveMode: "prompt_text_only", source: "default", canManage: true,
    modes: {
      prompt_text_only: { available: true },
      session_agent_account: { available: false },
      custom_model_endpoint: { available: false },
    },
  }),
  artifactUploadSettings: async () => ({ preference: "manual" }),
  assistantThreads: (options: { includeArchived?: boolean } = {}) => {
    const refusal = refused();
    if (refusal) return refusal;
    const read = { threads: structuredClone(threads.filter((candidate) => options.includeArchived || candidate.status !== "archived")) };
    // `assistantsSlowLists(ms)`: every later read answers after `ms`, with the threads as they were
    // when it began, as a slow control plane would.
    if (slowListMs > 0 && !holdNextList) return new Promise((resolve) => window.setTimeout(() => resolve(read), slowListMs));
    if (!holdNextList) return Promise.resolve(read);
    holdNextList = false;
    document.body.dataset.listHeld = "true";
    return new Promise((resolve) => { releaseHeldList = () => resolve(read); });
  },
  assistantThread: async (threadId: string) => {
    const refusal = refused();
    if (refusal) return refusal;
    return { thread: structuredClone(found(threadId)) };
  },
  assistantThreadDefaults: () => refused() ?? Promise.resolve(structuredClone(defaults)),
  setAssistantThreadLaunchDefaults: async (next: AssistantThreadLaunchDefaults) => {
    defaults.harness = next.harness;
    defaults.launchDefaults = next;
    return structuredClone(defaults);
  },
  assistantConnections: async () => ({
    installation: { id: "fixture-installation", name: "Home Studio", canRename: true },
    connections: Array.from({ length: limitsScenario === "stress" ? 9 : 1 }, (_, index) => ({
      id: `asst_${index}`,
      name: limitsScenario === "stress" ? longTitle(index + 1) : "Release Assistant",
      ownerUserId: "usr_owner", organizationId: "org_fixture",
      grant: { operations: "all", projects: "all", destructiveConfirmation: "confirm" },
      revision: 1, revoked: false,
    })),
    operations: [], projects: [],
  }),
  assistantThreadLimitDefaults: () => refused() ?? (limitsScenario && limitsScenario !== "old"
    ? Promise.resolve(structuredClone(limitDefaults)) : unavailable()),
  setAssistantThreadLimitDefaults: async (limits: AssistantThreadLimits) => {
    limitDefaults = limits;
    return structuredClone(limitDefaults);
  },
  setAssistantThreadLimits: async (threadId: string, limits: AssistantThreadLimits) => {
    const current = found(threadId);
    const committed = limitsScenario === "budget" ? 25 : 15;
    if (limits.costUsd !== null && limits.costUsd < committed) {
      throw new ApiError(`The thread has already spent or committed $${committed.toFixed(2)}. Choose a budget at least that high.`, 409);
    }
    current.usage = {
      costUsd: { used: current.usage!.costUsd.used, limit: limits.costUsd },
      launchedSessions: { used: current.usage!.launchedSessions.used, limit: limits.launchedSessions },
    };
    if (limits.costUsd !== 25) delete current.launchLimitRefusal;
    const backing = sessions.get(current.sessionId)!;
    upsert({ ...backing, assistantThreadBudget: { threadId, limitUsd: limits.costUsd }, costBudgetUsd: limits.costUsd });
    publish(current);
    return { thread: structuredClone(current) };
  },
  setAssistantThreadDelegation: async (threadId: string, delegation: AssistantDecisionDelegation) => {
    const current = found(threadId);
    if (current.decisionDelegation?.revision !== delegation.revision) throw new ApiError("Delegation changed in another window.", 409);
    current.decisionDelegation = { revision: delegation.revision + 1, grant: delegation.grant };
    document.body.dataset.delegationGrant = JSON.stringify(delegation.grant);
    publish(current);
    return { thread: structuredClone(current) };
  },
  assistantDecisionHistory: async (filter: { threadId?: string; before?: string }) => assistantDecisionHistoryFixture("campaign_0", filter.before),
  setConfig: async (sessionId: string, patch: SessionConfig) => {
    const current = threads.find((thread) => thread.sessionId === sessionId);
    if (current?.usage && patch.costBudgetUsd !== undefined) {
      await client.setAssistantThreadLimits(current.id, {
        costUsd: patch.costBudgetUsd > 0 ? patch.costBudgetUsd : null,
        launchedSessions: current.usage.launchedSessions.limit,
      });
    }
    return structuredClone(sessions.get(sessionId)!);
  },
  createAssistantThread: async (body: CreateAssistantThreadRequest) => {
    const refusal = refused();
    if (refusal) return refusal;
    const id = `thr_new_${threads.length + 1}`;
    const sessionId = `sess-new-${threads.length + 1}`;
    const harness = body.harness ?? defaults.harness;
    const choices = fixtureAccountChoices(harness);
    const saved = defaults.launchDefaults?.harness === harness ? defaults.launchDefaults?.providerAccount : null;
    const accountRef = body.providerAccountRef === undefined ? saved?.accountRef ?? choices.policyAccountRef
      : body.providerAccountRef ?? choices.policyAccountRef;
    const account = choices.accounts.find((candidate) => candidate.accountRef === accountRef);
    if (accountScenario && account) {
      accountSelections.set(id, account.accountRef);
      document.body.dataset.createdAccount = body.providerAccountRef ?? "policy";
    }
    upsert(session(sessionId, body.title ?? "New Thread", { createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0,
      ...(body.harness === "codex" ? { agentId: "codex", agentName: "Codex", driver: "codex-app-server" } : {}) }));
    const created: AssistantThread = {
      id, assistant: "wollipog", title: body.title ?? "", harness: body.harness ?? defaults.harness, sessionId, status: "done",
      access, connectionId: null, launchedSessionIds: [], lastActivityAt: Date.now(), createdAt: Date.now(), archivedAt: null,
      ...(accountScenario ? { accountChangeSupported: true, providerAccountLabel: account?.label } : {}),
    };
    if (limitsScenario && limitsScenario !== "old") {
      created.limitsEditable = true;
      created.usage = {
        costUsd: { used: 0, limit: limitDefaults.costUsd },
        launchedSessions: { used: 0, limit: limitDefaults.launchedSessions },
      };
    }
    threads = [created, ...threads];
    publish(created);
    return { thread: structuredClone(created) };
  },
  assistantThreadAccountChoices: async (threadId: string) => fixtureAccountChoices(found(threadId).harness, accountSelections.get(threadId)),
  changeAssistantThreadAccount: async (threadId: string, input: ChangeAssistantThreadAccountRequest) => {
    const current = found(threadId);
    const choices = fixtureAccountChoices(current.harness, accountSelections.get(threadId));
    const account = choices.accounts.find((option) => option.accountRef === input.providerAccountRef && !option.reason);
    if (!account || input.expectedProviderAccountRef !== (choices.currentAccountRef ?? null)) {
      throw new ApiError("The account choice changed. Open the picker again.", 409);
    }
    const changed = { ...current, providerAccountLabel: account.label };
    accountSelections.set(threadId, account.accountRef);
    document.body.dataset.changedAccount = account.accountRef;
    threads = threads.map((candidate) => candidate.id === threadId ? changed : candidate);
    publish(changed);
    return { thread: structuredClone(changed) };
  },
  renameAssistantThread: async (threadId: string, title: string) => {
    const renamed = { ...found(threadId), title };
    threads = threads.map((candidate) => candidate.id === threadId ? renamed : candidate);
    publish(renamed);
    return { thread: structuredClone(renamed) };
  },
  // `?confirm=1`: Approve Once runs the bound command once and Deny refuses it; either way the
  // thread stops listing the request and is republished.
  approveAssistantConfirmation: async (threadId: string, confirmationId: string) => settleConfirmation(threadId, confirmationId, "approve"),
  approveAssistantCampaign: async (threadId: string, confirmationId: string, digest: string) => {
    if (found(threadId).confirmations?.find(candidate => candidate.id === confirmationId)?.campaign?.digest !== digest) {
      throw new Error("Review the campaign again.");
    }
    return settleConfirmation(threadId, confirmationId, "approve");
  },
  reviseAssistantCampaignBudget: async (threadId: string, confirmationId: string, digest: string, budget: OrchestratorCampaignBudgetDefault) => {
    const current = found(threadId);
    const previous = current.confirmations?.find(candidate => candidate.id === confirmationId);
    if (!previous?.campaign || previous.campaign.digest !== digest) throw new Error("Review the campaign again.");
    const confirmation = { ...previous, campaign: { digest: "e".repeat(64), budget },
      impact: previous.impact.map(line => line.label === "Campaign Budget"
        ? { ...line, value: `$${budget.costUsd} USD · ${budget.toolCalls} tool calls` } : line) };
    const thread = { ...current, confirmations: current.confirmations!.map(candidate => candidate.id === confirmationId ? confirmation : candidate) };
    threads = threads.map(candidate => candidate.id === threadId ? thread : candidate);
    publish(thread);
    return { confirmation, thread };
  },
  denyAssistantConfirmation: async (threadId: string, confirmationId: string) => settleConfirmation(threadId, confirmationId, "deny"),
  answerQuestion: async (sessionId: string) => {
    const next = { ...sessions.get(sessionId)!, status: "running" as const, pendingApproval: null, updatedAt: Date.now() };
    upsert(next);
    const changed = threads.find((candidate) => candidate.sessionId === sessionId)!;
    const answered = { ...changed, status: "working" as const };
    threads = threads.map((candidate) => candidate === changed ? answered : candidate);
    publish(answered);
    return structuredClone(next);
  },
  archiveAssistantThread: async (threadId: string) => {
    const archived = { ...found(threadId), status: "archived" as const, archivedAt: Date.now() };
    threads = threads.map((candidate) => candidate.id === threadId ? archived : candidate);
    publish(archived);
    return { thread: structuredClone(archived) };
  },
  session: async (id: string) => ({ session: structuredClone(sessions.get(id)!) }),
  approve: async (id: string, body: { requestId: string; optionId: string | null }) => {
    const current = sessions.get(id)!;
    const next = { ...current, status: "running" as const, pendingApproval: null, updatedAt: Date.now() };
    document.body.dataset.approved = `${id}:${body.requestId}:${body.optionId}`;
    upsert(next);
    // The thread no longer waits on anyone once its only approval is answered.
    threads = threads.map((candidate) => candidate.launchedSessionIds.includes(id) ? { ...candidate, status: "working" } : candidate);
    for (const changed of threads.filter((candidate) => candidate.launchedSessionIds.includes(id))) publish(changed);
    return structuredClone(next);
  },
  getSessionEventPage: () => new Promise<never>(() => {}),
  getSessionEventTailPage: (id: string, _before: number | undefined, eventEpoch: number) => Promise.resolve({
    events: structuredClone(events[id] ?? []), eventEpoch, nextBefore: 0, hasMoreOlder: false, cacheComplete: true,
  }),
  descendantRequests: async () => ({ requests: [] }),
  git: async () => ({}),
  gitSummary: async () => ({}),
  reviewFindings: async () => ({ findings: [], summary: {
    total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete",
  } }),
  runnerSkills: async () => ({ desired: [], reported: null }),
} as unknown as ApiClient;

/** The triage thread's backing session reports activity without changing its status. */
function backingActivity() {
  const backing = sessions.get("sess-triage")!;
  upsert({ ...backing, messageCount: backing.messageCount + 1, lastEventAt: Date.now(), updatedAt: Date.now() });
}

Object.assign(window, {
  /** The running launched session finishes, as its stream would report it. */
  assistantsAdvance: () => upsert({ ...sessions.get("sess-flaky")!, status: "completed", updatedAt: Date.now() }),
  /** Mid-turn, the assistant launches another session: the thread's status stays as it was, and
   * the control plane republishes the thread with its new launch. */
  assistantsLaunch: () => {
    threads = threads.map((candidate) => candidate.id === "thr_triage"
      ? { ...candidate, launchedSessionIds: [...candidate.launchedSessionIds, "sess-changelog"], lastActivityAt: Date.now() } : candidate);
    upsert(session("sess-changelog", "Write the Changelog", { status: "running", updatedAt: Date.now() }));
    backingActivity();
    publish(threads.find((candidate) => candidate.id === "thr_triage")!);
  },
  assistantsActivity: backingActivity,
  /** A thread is renamed elsewhere and the control plane publishes it. */
  assistantsRenameElsewhere: (threadId: string, title: string) => {
    threads = threads.map((candidate) => candidate.id === threadId ? { ...candidate, title } : candidate);
    publish(threads.find((candidate) => candidate.id === threadId)!);
  },
  /** `count` more changes to one thread: `spacedMs` apart so the page renders between them, or all
   * in one task (0) so the page sees them in a single render. Resolves once the last is published. */
  assistantsFlood: (threadId: string, count: number, spacedMs: number) => new Promise<void>((resolve) => {
    let sent = 0;
    const next = () => {
      const current = threads.find((candidate) => candidate.id === threadId)!;
      const changed = { ...current, lastActivityAt: current.lastActivityAt + 1 };
      threads = threads.map((candidate) => candidate.id === threadId ? changed : candidate);
      publish(changed);
      sent += 1;
    };
    if (spacedMs === 0) {
      while (sent < count) next();
      resolve();
      return;
    }
    const timer = window.setInterval(() => {
      next();
      if (sent >= count) {
        window.clearInterval(timer);
        resolve();
      }
    }, spacedMs);
  }),
  /** A thread's status changes and the control plane publishes it, without any list read. */
  assistantsThreadStatus: (threadId: string, status: AssistantThread["status"]) => {
    threads = threads.map((candidate) => candidate.id === threadId ? { ...candidate, status } : candidate);
    publish(threads.find((candidate) => candidate.id === threadId)!);
  },
  assistantsHoldNextList: () => { holdNextList = true; },
  assistantsSlowLists: (ms: number) => { slowListMs = ms; },
  assistantsReleaseList: () => {
    releaseHeldList?.();
    releaseHeldList = null;
  },
});

/** The harness page's own URL scheme: the SPA path rides in `?path=`. */
const navigation: ViewNavigation = {
  current: () => {
    const path = new URLSearchParams(window.location.search).get("path") ?? "/assistants";
    const url = new URL(path, window.location.origin);
    const view = viewFromPath(url.pathname, url.search) ?? { name: "assistants" };
    if (viewPath(view) !== path) navigation.replace?.(view);
    return view;
  },
  push: (view) => {
    const url = new URL(window.location.href);
    url.searchParams.set("path", viewPath(view));
    window.history.pushState(null, "", url);
  },
  replace: (view) => {
    const url = new URL(window.location.href);
    url.searchParams.set("path", viewPath(view));
    window.history.replaceState(null, "", url);
  },
  listen: (onView) => {
    const onPop = () => onView(navigation.current());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  },
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <InstanceScopeProvider instanceScope={SCOPE}>
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          <ThemeProvider><Shell /></ThemeProvider>
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>
  </InstanceScopeProvider>,
);
