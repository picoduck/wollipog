import React, { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type AgentSlashCommand,
  type CreateSessionRequest,
  type ControlPlaneToUi,
  type GitStatusInfo,
  type GitSummaryInfo,
  type InvokeSessionCommandRequest,
  type PodView,
  type PromptImageInput,
  type ProjectView,
  type RunView,
  type RunnerView,
  type SessionConfig,
  type SessionCommandInvocationView,
  type SessionCapabilityOverlay,
  type SessionEvent,
  type SessionView,
  type SteerDisposition,
  type SteerRequest,
  type SteerResultReason,
  type SteeringAttemptView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import type { ProviderComposerCommand } from "../composer-commands.js";
import { loadComposerDraft, type ComposerDraft } from "../composer-drafts.js";
import {
  queuedEditRecoveryAccountKey,
  saveDurableQueuedEditRecovery,
  type QueuedPromptEditRecovery,
} from "../queued-edit-recovery.js";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { InboxView } from "../components/InboxView.js";
import { NewSessionDialog, type NewSessionPreset } from "../components/NewSessionDialog.js";
import { PodDetail } from "../components/PodsView.js";
import { ProjectsView } from "../components/ProjectsView.js";
import { RunDetail } from "../components/RunsView.js";
import { SessionDetail } from "../components/SessionDetail.js";
import { ShellDock } from "../components/ShellDock.js";
import { useRightPanelState } from "../components/RightPanel.js";
import { useIsMobile } from "../components/useIsMobile.js";
import { Header } from "../App.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { useNewSessionShortcut } from "../useNewSessionShortcut.js";
import "../styles.css";

const FIXTURE_QUERY = new URLSearchParams(window.location.search);
const SCENARIO = FIXTURE_QUERY.get("scenario");
const REVIEW_READY = FIXTURE_QUERY.get("reviewReady") === "1";
const INCLUDE_SESSION_SHELL = FIXTURE_QUERY.get("sessionShell") === "1";
const LEGACY_WORKSPACES = FIXTURE_QUERY.get("legacyWorkspaces") === "1";
const UNFILED_WORKSPACE = FIXTURE_QUERY.get("unfiledWorkspace") === "1";
const HISTORY_PAGE_DELAY_MS = Number(FIXTURE_QUERY.get("historyDelay") ?? 25);
const STORAGE_KEY = `wollipog.e2e.project-inbox-model${SCENARIO ? `.${SCENARIO}` : ""}`;

interface FixtureModel {
  projects: ProjectView[];
  sessions: SessionView[];
}

interface SteeringFixtureResult {
  state: SteerDisposition;
  reason?: SteerResultReason;
  emitCanonicalEvent?: boolean;
}

interface PromptFixtureRequest {
  sessionId: string;
  text: string;
  images: PromptImageInput[];
  config?: SessionConfig;
  slashCommand?: string;
}

interface SessionCommandFixtureRequest {
  sessionId: string;
  request: InvokeSessionCommandRequest;
}

function project(id: string, name: string, options: Partial<ProjectView> = {}): ProjectView {
  return {
    id,
    name,
    hidden: false,
    audience: "organization",
    locations: [],
    activeSessionCount: 0,
    unarchivedSessionCount: 0,
    totalSessionCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...options,
  };
}

function session(id: string, title: string, projectId: string | null, workspaceId: string): SessionView {
  return {
    id,
    runnerId: "runner-1",
    workspaceId,
    workspaceName: workspaceId,
    projectId,
    projectLocationId: projectId ? `location-${projectId}` : null,
    audience: "organization",
    agentId: "codex",
    agentName: "Codex",
    title,
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: 1,
    eventEpoch: 0,
    messageCount: 1,
    preview: `${title} preview`,
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
  };
}

function initialModel(): FixtureModel {
  const location = {
    id: "location-alpha",
    projectId: "alpha",
    runnerId: "runner-1",
    workspaceId: "alpha-workspace",
    name: "Alpha",
    path: "/repos/alpha",
    source: "managed" as const,
    availability: "available" as const,
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const initial = {
    projects: [
      project("alpha", "Alpha", { locations: [location], unarchivedSessionCount: 1, totalSessionCount: 1 }),
      project("gamma", "Gamma"),
      project("secret", "Secret", { hidden: true, unarchivedSessionCount: 1, totalSessionCount: 1 }),
    ],
    sessions: [
      session("session-alpha", "Alpha Session", "alpha", "alpha-workspace"),
      session("session-secret", "Secret Session", "secret", "secret-workspace"),
      session("session-no-project", "No Project Session", null, "loose-workspace"),
    ],
  };
  if (SCENARIO === "inbox-live-scroll") {
    initial.sessions = Array.from({ length: 36 }, (_, index) => {
      const value = session(
        `session-overflow-${index}`,
        `Overflow Session ${String(index + 1).padStart(2, "0")}`,
        "alpha",
        "alpha-workspace",
      );
      Object.assign(value, {
        status: index < 4 ? "running" : "idle",
        activeTurnId: index < 4 ? `turn-overflow-${index}` : null,
        updatedAt: 100 - index,
        lastEventAt: 100 - index,
        preview: index < 4 ? `Running activity ${index + 1}` : `Waiting session ${index + 1}`,
      });
      return value;
    });
    initial.projects[0]!.unarchivedSessionCount = initial.sessions.length;
    initial.projects[0]!.totalSessionCount = initial.sessions.length;
  }
  if (SCENARIO === "inbox-row-layout") {
    // The shapes #664 has to survive at once: a title long enough to fill any viewport, a branch
    // name long enough to fill the third line on its own, a default base ref that must stay hidden,
    // a non-default one that must show, and rows with no worktree at all that stay two lines.
    const rows: Array<[string, string, Partial<SessionView>]> = [
      ["session-long-branch", "Restructure Inbox Rows so the Title Fades and the Activity Strip Is Always Visible", {
        useWorktree: true,
        worktreePath: "/repos/alpha/.agent-worktrees/long",
        worktrees: [{
          id: "wt-long",
          path: "/repos/alpha/.agent-worktrees/long",
          branch: "fix/issue-664-restructure-inbox-rows-so-the-activity-strip-is-always-visible",
          baseRef: "origin/main",
          source: "created",
          pullRequest: { url: "https://github.com/picoduck/wollipog/pull/664", state: "open" },
        }],
      }],
      ["session-stacked-base", "Short Title", {
        useWorktree: true,
        worktreePath: "/repos/alpha/.agent-worktrees/stacked",
        worktrees: [{
          id: "wt-stacked",
          path: "/repos/alpha/.agent-worktrees/stacked",
          branch: "fix/issue-664-follow-up",
          baseRef: "fix/issue-664-restructure-inbox-rows-so-the-activity-strip-is-always-visible",
          source: "created",
          pullRequest: { url: "https://github.com/picoduck/wollipog/pull/665", state: "merged" },
        }],
      }],
      // Session titles are derived from the opening prompt, so they get long. This one is long
      // enough to clip at 1400px, which is where the strip used to look safe.
      // Line three's own version of the #664 failure: if anything on it refuses to shrink, the
      // branch collapses before it yields and the PR pill is pushed past the line's clip.
      ["session-long-base", "Stacked on a Long Base", {
        useWorktree: true,
        worktreePath: "/repos/alpha/.agent-worktrees/long-base",
        worktrees: [{
          id: "wt-long-base",
          path: "/repos/alpha/.agent-worktrees/long-base",
          branch: "fix/issue-664-restructure-inbox-rows-so-the-activity-strip-is-always-visible",
          baseRef: "release/2027-q1-hardening-of-the-inbox-virtualisation-and-activity-strip-measurement-path",
          source: "created",
          pullRequest: { url: "https://github.com/picoduck/wollipog/pull/666", state: "closed" },
        }],
      }],
      // #679: this repository's default is `develop`, so an explicit `origin/main` base is a
      // deliberate choice the row has to keep. Before the default branch was carried, the name
      // heuristic suppressed it.
      ["session-nondefault-repo", "Branched From Main in a Develop-Default Repository", {
        useWorktree: true,
        worktreePath: "/repos/alpha/.agent-worktrees/develop-default",
        worktrees: [{
          id: "wt-develop-default",
          path: "/repos/alpha/.agent-worktrees/develop-default",
          branch: "fix/issue-679-default-branch",
          baseRef: "origin/main",
          defaultBranch: "develop",
          source: "created",
        }],
      }],
      ["session-default-repo", "Branched From the Default of a Develop-Default Repository", {
        useWorktree: true,
        worktreePath: "/repos/alpha/.agent-worktrees/develop-base",
        worktrees: [{
          id: "wt-develop-base",
          path: "/repos/alpha/.agent-worktrees/develop-base",
          branch: "fix/issue-679-follow-up",
          baseRef: "origin/develop",
          defaultBranch: "develop",
          source: "created",
        }],
      }],
      ["session-no-worktree", "A Session With No Worktree Whose Title Was Derived From a Long Opening Prompt and Therefore Runs Well Past the Width of Any Viewport the Inbox Is Ever Rendered At, Including the Widest Desktop Layout", {}],
      ["session-plain", "Plain", {}],
    ];
    initial.sessions = rows.map(([id, title, extra], index) => {
      const value = session(id, title, "alpha", "alpha-workspace");
      Object.assign(value, {
        status: "running",
        activeTurnId: `turn-${id}`,
        updatedAt: 100 - index,
        lastEventAt: 100 - index,
        ...extra,
      });
      return value;
    });
    initial.projects[0]!.unarchivedSessionCount = initial.sessions.length;
    initial.projects[0]!.totalSessionCount = initial.sessions.length;
  }
  if (SCENARIO === "imported-location") {
    Object.assign(initial.projects.find((candidate) => candidate.id === "gamma")!, { canManage: true });
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-no-project")!, {
      adopted: true,
      importLocationReady: true,
      status: "running",
      activeTurnId: "turn-imported",
      queued: [{ id: "prompt-next", text: "Continue" }],
      queueHeld: true,
    });
  }
  if (SCENARIO === "conversation-steering") {
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      status: "running",
      activeTurnId: "turn-active",
      agentCapabilities: {
        models: [],
        effortLevels: [],
        slashCommands: [{ name: "review", source: "builtin", description: "Review the current changes" }],
        supportsImages: false,
        supportsApprovals: true,
        supportsSteering: true,
      },
    });
  }
  if (SCENARIO === "composer-restart") {
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      status: "stopped",
      activeTurnId: null,
    });
  }
  if (SCENARIO === "git-visibility") {
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      useWorktree: true,
      worktreePath: "/repos/alpha/.agent-worktrees/session-alpha",
    });
  }
  if (SCENARIO === "worktree-identity" || SCENARIO === "unsafe-worktree-pr") {
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      useWorktree: true,
      worktreePath: "/repos/alpha/.agent-worktrees/fix-583",
      worktrees: [{
        id: "wt-fix-583",
        path: "/repos/alpha/.agent-worktrees/fix-583",
        branch: "fix/session-worktree-identity",
        baseRef: "origin/main",
        baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: "created",
        pullRequest: {
          url: SCENARIO === "unsafe-worktree-pr"
            ? "javascript:alert('unsafe')"
            : "https://github.com/picoduck/wollipog/pull/600",
          state: "open",
        },
      }],
    });
  }
  if (UNFILED_WORKSPACE) {
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      projectId: null,
      projectLocationId: null,
      workspaceId: null,
      workspaceName: null,
    });
  }
  return initial;
}

function loadModel(): FixtureModel {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored ? JSON.parse(stored) as FixtureModel : initialModel();
}

let model = loadModel();
let socket: FixtureSocket | null = null;
type GitFixtureAction = "status" | "summary";
const longGitBranch = "feature/session-alpha-with-a-deliberately-long-branch-name-for-narrow-layout-validation";
const defaultGitStatus = (id: string): GitStatusInfo => ({
  branch: id === "session-no-project" ? "HEAD" : id === "session-alpha" ? longGitBranch : "main",
  files: [],
  hasChanges: id === "session-alpha",
  ahead: id === "session-alpha" && REVIEW_READY ? 2 : 0,
  remoteUrl: "https://github.com/example/wollipog.git",
  headSha: id === "session-no-project" ? "bbbbbbbbbbbb" : id === "session-alpha" ? "aaaaaaaaaaaa" : "cccccccccccc",
  detached: id === "session-no-project",
  upstreamBranch: id === "session-no-project" ? null : id === "session-alpha" ? `origin/${longGitBranch}` : "origin/main",
  aheadUpstream: id === "session-no-project" ? null : 0,
  behindUpstream: id === "session-no-project" ? null : 0,
  baseRef: "origin/main",
  worktreeKind: id === "session-alpha" ? "linked" : "primary",
  shallow: false,
  stagedCount: id === "session-alpha" ? 2 : 0,
  modifiedCount: id === "session-alpha" ? 1 : 0,
  untrackedCount: id === "session-alpha" ? 1 : 0,
  conflictedCount: id === "session-alpha" ? 1 : 0,
  operation: id === "session-alpha" ? "rebase" : null,
  remoteRefsAt: Date.now() - 120_000,
  addedLines: id === "session-alpha" ? 9 : 0,
  deletedLines: id === "session-alpha" ? 3 : 0,
});
const gitFixtures = new Map<string, { status: GitStatusInfo; summary: GitSummaryInfo }>();
for (const value of model.sessions) {
  const fixtureStatus = defaultGitStatus(value.id);
  gitFixtures.set(value.id, {
    status: fixtureStatus,
    summary: {
      ...fixtureStatus,
      behind: value.id === "session-alpha" ? 231 : value.id === "session-no-project" ? 7 : 0,
      addedLines: fixtureStatus.addedLines ?? 0,
      deletedLines: fixtureStatus.deletedLines ?? 0,
      pr: SCENARIO === "git-visibility" && value.id === "session-alpha"
        ? { number: 318, title: "Alpha Visibility PR", url: "https://github.com/example/wollipog/pull/318", state: "OPEN" }
        : null,
      checks: null,
    },
  });
}
const gitRequestCounts = new Map<string, { status: number; summary: number }>();
const deferredGitRequests = new Set<string>();
const heldGitSessions = new Set<string>();
const pendingGitRequests = new Map<string, Array<() => void>>();
const failingGitRequests = new Map<string, string>();
const unavailableGitSessions = new Set<string>();
if (new URLSearchParams(window.location.search).get("deferGit") === "alpha") {
  heldGitSessions.add("session-alpha");
}

function gitRequestKey(id: string, action: GitFixtureAction): string {
  return `${id}:${action}`;
}

async function waitForGitFixture(id: string, action: GitFixtureAction): Promise<void> {
  const counts = gitRequestCounts.get(id) ?? { status: 0, summary: 0 };
  counts[action] += 1;
  gitRequestCounts.set(id, counts);
  const key = gitRequestKey(id, action);
  if (heldGitSessions.has(id) || deferredGitRequests.delete(key)) {
    await new Promise<void>((resolve) => {
      const pending = pendingGitRequests.get(key) ?? [];
      pending.push(resolve);
      pendingGitRequests.set(key, pending);
    });
  }
  const failure = failingGitRequests.get(key);
  if (failure) {
    failingGitRequests.delete(key);
    throw new Error(failure);
  }
}
let lastCreateSessionRequest: CreateSessionRequest | null = null;
let terminalOpenCount = 0;
let cancelTurnCount = 0;
let failNextCancelTurn = false;
let deferNextCancelTurnRequest = false;
let pendingCancelTurnSettlement: (() => void) | null = null;
let deferNextPromptRequest = false;
let pendingPromptSettlement: (() => void) | null = null;
const promptRequests: PromptFixtureRequest[] = [];
const restartRequests: string[] = [];
const sessionCommandRequests: SessionCommandFixtureRequest[] = [];
let failNextSessionCommandResponse = false;
let deferNextSessionCommandResponse = false;
let pendingSessionCommandSettlement: (() => void) | null = null;
let deferNextRetitleRequest = false;
let pendingRetitleSettlement: ((result: { title?: string; error?: string }) => void) | null = null;
const retitleRequests: string[] = [];
let nextSteeringResult: SteeringFixtureResult = {
  state: "accepted",
  reason: "accepted",
  emitCanonicalEvent: true,
};
let failNextSteeringRequest = false;
let deferNextSteeringResult = false;
let pendingSteeringSettlement: ((result: SteeringFixtureResult) => void) | null = null;
const steeringRequests: SteerRequest[] = [];
const steeringResolutionRequests: Array<{
  sessionId: string;
  submissionId: string;
  action: "queue_again" | "dismiss";
}> = [];
let deferredSteeringResolutionCount = 0;
const pendingSteeringResolutionSettlements = new Map<string, () => void>();
const sessionEvents = new Map<string, SessionEvent[]>();
const sessionEventPageRequests: Array<{ sessionId: string; after: number; direction?: "backward" }> = [];
if (SCENARIO === "preview-follow" || SCENARIO === "scroll-restore" ||
    SCENARIO === "preview-opening-fill") {
  const sessionIds = SCENARIO === "scroll-restore"
    ? ["session-alpha", "session-no-project"]
    : ["session-alpha"];
  for (const sessionId of sessionIds) {
    const value = model.sessions.find((candidate) => candidate.id === sessionId);
    if (!value) throw new Error(`${SCENARIO} fixture requires ${sessionId}`);
    const label = sessionId === "session-alpha" ? "Alpha" : "No Project";
    const events = SCENARIO === "preview-opening-fill"
      ? [
          ...Array.from({ length: 48 }, (_, index): SessionEvent => {
            const seq = index + 1;
            return {
              id: seq,
              sessionId: value.id,
              seq,
              ts: seq,
              payload: index % 2 === 0
                ? { kind: "user_message", text: `${label} earlier question ${seq}.`, turnId: `${sessionId}-turn-${seq}` }
                : {
                    kind: "agent_message",
                    text: `${label} earlier response ${seq}. ${"Older useful context fills the preview reader. ".repeat(12)}`,
                    final: true,
                    messageId: `${sessionId}-message-${seq}`,
                  },
            };
          }),
          {
            id: 49,
            sessionId: value.id,
            seq: 49,
            ts: 49,
            payload: { kind: "user_message", text: `${label} event-heavy question.`, turnId: `${sessionId}-heavy-turn` },
          } as SessionEvent,
          ...Array.from({ length: 220 }, (_, index): SessionEvent => {
            const seq = index + 50;
            return {
              id: seq,
              sessionId: value.id,
              seq,
              ts: seq,
              payload: {
                kind: "agent_message",
                text: index === 219 ? "Compact final response." : ".",
                final: index === 219,
                messageId: `${sessionId}-heavy-message`,
              },
            };
          }),
        ]
      : Array.from({ length: 56 }, (_, index): SessionEvent => {
      const seq = index + 1;
      const turnId = `${sessionId}-preview-turn-${Math.floor(index / 2) + 1}`;
      return {
        id: seq,
        sessionId: value.id,
        seq,
        ts: seq,
        payload: index % 2 === 0
          ? { kind: "user_message", text: `${label} question ${seq}: keep this row stable while output streams.`, turnId }
          : {
              kind: "agent_message",
              text: `${label} response ${seq}. ${"Measured streaming output keeps the transcript tall. ".repeat(8)}`,
              final: true,
              messageId: `${sessionId}-preview-message-${seq}`,
            },
      };
        });
    sessionEvents.set(value.id, events);
    Object.assign(value, {
      status: "running",
      activeTurnId: `${sessionId}-live-turn`,
      messageCount: events.length,
      updatedAt: events.length,
      lastEventAt: events.length,
    });
  }
}
let fixtureProviderCommandAttachmentPolicy: ProviderComposerCommand["attachmentPolicy"] = "send";
let updateFixtureProviderCommandAttachmentPolicy:
  ((policy: ProviderComposerCommand["attachmentPolicy"]) => void) | null = null;

function saveModel(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(model));
}

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "fixture-runner",
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
    context: { kind: "native" },
    available: true,
    capabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [{ name: "review", source: "builtin", description: "Review the current changes" }],
      supportsImages: false,
      supportsApprovals: true,
      ...(SCENARIO === "conversation-steering" ? { supportsSteering: true } : {}),
    },
  }],
  workspaces: [
    { id: "alpha-workspace", name: "Alpha", path: "/repos/alpha" },
    { id: "alpha-secondary-workspace", name: "Alpha Secondary", path: "/repos/alpha-secondary" },
    { id: "alpha-copy-workspace", name: "Alpha Copy", path: "/repos/alpha-copy" },
    { id: "secret-workspace", name: "Secret", path: "/repos/secret" },
    { id: "loose-workspace", name: "Loose", path: "/repos/loose" },
  ],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
};

const activePod: PodView = {
  id: "pod-active",
  title: "Active Collaboration Pod",
  objective: "Manual collaboration pod",
  status: "active",
  members: [],
  createdAt: 1,
  updatedAt: 1,
};

const activeRun: RunView = {
  id: "run-active",
  title: "Final QA Run",
  prompt: "Verify the shared detail header remains unchanged.",
  workspaceId: "alpha-workspace",
  workspaceName: "Alpha",
  createdAt: 1,
  updatedAt: 1,
  sessionIds: [],
};

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: !LEGACY_WORKSPACES,
      createProjectLocations: !LEGACY_WORKSPACES,
      nativeTuiLaunch: true,
      stopBeforeArchive: true,
    },
    runners: [runner],
    boxes: [],
    ...(LEGACY_WORKSPACES ? {} : { projects: structuredClone(model.projects) }),
    sessions: structuredClone(model.sessions.filter((candidate) => !candidate.archived)),
    runs: [structuredClone(activeRun)],
    pods: [structuredClone(activePod)],
  };
}

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    window.setTimeout(() => {
      this.onopen?.();
      this.push(snapshot());
    }, 0);
  }
  send() {}
  close() {}
  push(message: ControlPlaneToUi): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const connection: UiConnectionRuntime = {
  instanceId: "project-inbox-e2e",
  runtimeKey: "project-inbox-e2e:1",
  createSocket() {
    socket = new FixtureSocket();
    return socket;
  },
  close() {},
};

const navigation: ViewNavigation = {
  current: () => {
    const fixtureView = new URLSearchParams(window.location.search).get("view");
    if (fixtureView === "pod") return { name: "pod", id: activePod.id };
    if (fixtureView === "run") return { name: "run", id: activeRun.id };
    return { name: "inbox" };
  },
  push() {},
  listen: () => () => {},
};

function pushSession(value: SessionView): void {
  saveModel();
  socket?.push({ type: "session_upsert", session: structuredClone(value) });
}

function upsertSteeringAttempt(value: SessionView, attempt: SteeringAttemptView): void {
  const attempts = value.steeringAttempts ?? [];
  const index = attempts.findIndex((candidate) => candidate.submissionId === attempt.submissionId);
  value.steeringAttempts = index === -1
    ? [...attempts, structuredClone(attempt)]
    : attempts.map((candidate, attemptIndex) => attemptIndex === index ? structuredClone(attempt) : candidate);
  value.updatedAt = Math.max(value.updatedAt + 1, attempt.updatedAt);
}

function pushCanonicalSteeredMessage(
  value: SessionView,
  text: string,
  turnId: string,
  submissionId: string,
): void {
  const seq = value.messageCount + 1;
  value.messageCount = seq;
  value.updatedAt += 1;
  value.lastEventAt = value.updatedAt;
  const event: SessionEvent = {
    id: seq,
    sessionId: value.id,
    seq,
    ts: value.updatedAt,
    payload: { kind: "user_message", text, turnId, submissionId, deliveryIntent: "steer" },
  };
  sessionEvents.set(value.id, [...(sessionEvents.get(value.id) ?? []), event]);
  socket?.push({
    type: "session_event",
    event,
  });
}

function settleSteeringAttempt(
  value: SessionView,
  submissionId: string,
  result: SteeringFixtureResult,
): SteeringAttemptView {
  const existing = value.steeringAttempts?.find((candidate) => candidate.submissionId === submissionId);
  if (!existing) throw new Error(`unknown steering attempt: ${submissionId}`);
  const sourceQueue = existing.sourceQueueId
    ? value.queued?.find((candidate) => candidate.id === existing.sourceQueueId)
    : undefined;
  const queuedPromptId = result.state === "converted_to_queue"
    ? existing.queuedPromptId ?? `queued-${submissionId}`
    : existing.queuedPromptId;
  const attempt: SteeringAttemptView = {
    ...existing,
    state: result.state,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(queuedPromptId ? { queuedPromptId } : {}),
    updatedAt: existing.updatedAt + 1,
  };

  if (existing.source === "queued") {
    if (result.state === "accepted") {
      value.queued = value.queued?.filter((candidate) => candidate.id !== existing.sourceQueueId);
    } else if (sourceQueue) {
      sourceQueue.steeringState = result.state === "uncertain" ? "uncertain" : undefined;
    }
  } else if (result.state === "converted_to_queue" && !value.queued?.some((candidate) => candidate.id === queuedPromptId)) {
    value.queued = [...(value.queued ?? []), { id: queuedPromptId!, text: existing.text }];
  }

  upsertSteeringAttempt(value, attempt);
  if (result.state === "accepted" && result.emitCanonicalEvent !== false) {
    pushCanonicalSteeredMessage(value, existing.text, existing.turnId, existing.submissionId);
  }
  pushSession(value);
  return structuredClone(attempt);
}

const client = {
  ...api,
  getIdentity: async () => ({
    context: {
      userId: "fixture-user",
      userName: "Fixture User",
      organizationId: "fixture-organization",
      organizationName: "Fixture Organization",
      role: "owner" as const,
      deviceId: "fixture-device",
      localBootstrap: false,
    },
    organizations: [],
    memberships: [],
    teams: [],
  }),
  artifactExport: async () => {
    const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: "image/png" });
  },
  git: async (id: string) => {
    await waitForGitFixture(id, "status");
    if (unavailableGitSessions.has(id)) return {};
    const fixture = gitFixtures.get(id);
    if (!fixture) throw new Error("not a git repository");
    return { status: structuredClone(fixture.status) };
  },
  gitSummary: async (id: string) => {
    await waitForGitFixture(id, "summary");
    if (unavailableGitSessions.has(id)) return {};
    const fixture = gitFixtures.get(id);
    if (!fixture) throw new Error("not a git repository");
    return { summary: structuredClone(fixture.summary) };
  },
  workflowInstances: async () => [],
  runWorkflowArtifacts: async () => ({ artifacts: [], nextCursor: undefined }),
  createSession: async (request: CreateSessionRequest) => {
    lastCreateSessionRequest = structuredClone(request);
    const created = session(
      `session-created-${model.sessions.length + 1}`,
      "Created Session",
      request.projectId ?? null,
      request.workspaceId,
    );
    created.projectLocationId = request.projectLocationId ?? null;
    if (request.launchSurface === "native_tui") {
      created.agentCapabilities = { elicitation: { default: ["hook"] } };
    }
    model.sessions.push(created);
    const owningProject = request.projectId
      ? model.projects.find((candidate) => candidate.id === request.projectId)
      : undefined;
    if (owningProject) {
      owningProject.unarchivedSessionCount += 1;
      owningProject.totalSessionCount += 1;
      owningProject.updatedAt += 1;
    }
    saveModel();
    window.setTimeout(() => {
      socket?.push({ type: "session_upsert", session: structuredClone(created) });
      if (owningProject) socket?.push({ type: "project_upsert", project: structuredClone(owningProject) });
    }, 0);
    return structuredClone(created);
  },
  session: async (id: string) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    return { session: structuredClone(value) };
  },
  retitleSession: async (id: string) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    retitleRequests.push(id);
    const result = deferNextRetitleRequest
      ? await new Promise<{ title?: string; error?: string }>((resolve) => {
          deferNextRetitleRequest = false;
          pendingRetitleSettlement = resolve;
        })
      : { title: "Retitled Session" };
    pendingRetitleSettlement = null;
    if (result.error) throw new Error(result.error);
    const title = result.title ?? "Retitled Session";
    Object.assign(value, { title, titleSource: "user", updatedAt: value.updatedAt + 1 });
    pushSession(value);
    return { title };
  },
  setConfig: async (id: string, config: SessionConfig) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    Object.assign(value, config, { updatedAt: value.updatedAt + 1 });
    saveModel();
    socket?.push({ type: "session_upsert", session: structuredClone(value) });
    return structuredClone(value);
  },
  cancelTurn: async (id: string) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    cancelTurnCount += 1;
    if (failNextCancelTurn) {
      failNextCancelTurn = false;
      throw new Error("Simulated stop failure");
    }
    if (deferNextCancelTurnRequest) {
      deferNextCancelTurnRequest = false;
      await new Promise<void>((resolve) => {
        pendingCancelTurnSettlement = resolve;
      });
      pendingCancelTurnSettlement = null;
    }
    return structuredClone(value);
  },
  stop: async (id: string) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    Object.assign(value, {
      status: "stopped" as const,
      activeTurnId: undefined,
      queued: [],
      pendingApproval: null,
      updatedAt: value.updatedAt + 1,
    });
    saveModel();
    socket?.push({ type: "session_upsert", session: structuredClone(value) });
    return structuredClone(value);
  },
  restart: async (id: string) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    restartRequests.push(id);
    Object.assign(value, { status: "starting" as const, updatedAt: value.updatedAt + 1 });
    saveModel();
    socket?.push({ type: "session_upsert", session: structuredClone(value) });
    return structuredClone(value);
  },
  prompt: async (
    id: string,
    text: string,
    images: PromptImageInput[] = [],
    config?: SessionConfig,
    slashCommand?: string,
  ) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    promptRequests.push(structuredClone({
      sessionId: id,
      text,
      images,
      ...(config ? { config } : {}),
      ...(slashCommand ? { slashCommand } : {}),
    }));
    if (deferNextPromptRequest) {
      deferNextPromptRequest = false;
      await new Promise<void>((resolve) => {
        pendingPromptSettlement = resolve;
      });
      pendingPromptSettlement = null;
    }
    return structuredClone(value);
  },
  invokeSessionCommand: async (id: string, request: InvokeSessionCommandRequest) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    const command = runner.agents[0]?.capabilities?.slashCommands.find((candidate) =>
      candidate.invocation?.id === request.providerCommandId &&
      candidate.invocation.catalogRevision === request.catalogRevision
    );
    if (!command?.invocation) throw new Error("provider command not found");
    sessionCommandRequests.push(structuredClone({ sessionId: id, request }));
    const existing = value.commandInvocations?.find((candidate) =>
      candidate.submissionId === request.submissionId);
    if (existing) {
      if (failNextSessionCommandResponse) {
        failNextSessionCommandResponse = false;
        throw new Error("Simulated lost provider command response");
      }
      return structuredClone(existing);
    }
    const now = Math.max(Date.now(), value.updatedAt + 1);
    const invocation: SessionCommandInvocationView = {
      invocationId: `fixture-command-${sessionCommandRequests.length}`,
      submissionId: request.submissionId,
      sessionId: id,
      providerCommandId: request.providerCommandId,
      catalogRevision: request.catalogRevision,
      commandName: command.name,
      argumentText: request.argumentText,
      executionMode: command.invocation.executionMode,
      state: "sent",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    value.commandInvocations = [invocation, ...(value.commandInvocations ?? [])];
    pushSession(value);
    if (failNextSessionCommandResponse) {
      failNextSessionCommandResponse = false;
      throw new Error("Simulated lost provider command response");
    }
    if (deferNextSessionCommandResponse) {
      deferNextSessionCommandResponse = false;
      await new Promise<void>((resolve) => {
        pendingSessionCommandSettlement = resolve;
      });
      pendingSessionCommandSettlement = null;
    }
    return structuredClone(invocation);
  },
  steer: async (id: string, request: SteerRequest) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    steeringRequests.push(structuredClone(request));
    if (failNextSteeringRequest) {
      failNextSteeringRequest = false;
      throw new Error("Simulated steering transport failure");
    }
    const sourceQueue = request.promotePromptId
      ? value.queued?.find((candidate) => candidate.id === request.promotePromptId)
      : undefined;
    if (request.promotePromptId && !sourceQueue) throw new Error("queued prompt not found");
    if (sourceQueue) sourceQueue.steeringState = "promoting";
    const now = Math.max(Date.now(), value.updatedAt + 1);
    const pending: SteeringAttemptView = {
      submissionId: request.submissionId,
      turnId: request.turnId,
      source: sourceQueue ? "queued" : "direct",
      ...(sourceQueue ? { sourceQueueId: sourceQueue.id } : {}),
      text: request.text ?? sourceQueue?.text ?? "",
      hasImages: Boolean(request.images?.length || sourceQueue?.hasImages),
      state: "pending",
      createdAt: now,
      updatedAt: now,
    };
    upsertSteeringAttempt(value, pending);
    pushSession(value);

    let result = nextSteeringResult;
    nextSteeringResult = { state: "accepted", reason: "accepted", emitCanonicalEvent: true };
    if (deferNextSteeringResult) {
      deferNextSteeringResult = false;
      result = await new Promise<SteeringFixtureResult>((resolve) => {
        pendingSteeringSettlement = resolve;
      });
      pendingSteeringSettlement = null;
    }
    return settleSteeringAttempt(value, request.submissionId, result);
  },
  resolveSteeringAttempt: async (
    id: string,
    submissionId: string,
    action: "queue_again" | "dismiss",
  ) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    const attempt = value?.steeringAttempts?.find((candidate) => candidate.submissionId === submissionId);
    if (!value || !attempt) throw new Error("steering attempt not found");
    steeringResolutionRequests.push({ sessionId: id, submissionId, action });
    if (deferredSteeringResolutionCount > 0) {
      deferredSteeringResolutionCount -= 1;
      await new Promise<void>((resolve) => {
        pendingSteeringResolutionSettlements.set(submissionId, resolve);
      });
      pendingSteeringResolutionSettlements.delete(submissionId);
    }
    const queuedPromptId = action === "queue_again"
      ? attempt.queuedPromptId ?? `queued-again-${submissionId}`
      : undefined;
    const resolved: SteeringAttemptView = {
      ...attempt,
      resolution: {
        action,
        state: "applied",
        ...(queuedPromptId ? { queuedPromptId } : {}),
      },
      updatedAt: attempt.updatedAt + 1,
    };
    if (attempt.sourceQueueId) {
      if (action === "dismiss") {
        value.queued = value.queued?.filter((candidate) => candidate.id !== attempt.sourceQueueId);
      } else {
        const sourceQueue = value.queued?.find((candidate) => candidate.id === attempt.sourceQueueId);
        if (sourceQueue) sourceQueue.steeringState = undefined;
      }
    } else if (queuedPromptId && !value.queued?.some((candidate) => candidate.id === queuedPromptId)) {
      value.queued = [...(value.queued ?? []), { id: queuedPromptId, text: attempt.text }];
    }
    upsertSteeringAttempt(value, resolved);
    pushSession(value);
    return structuredClone(resolved);
  },
  listShells: async (sessionId: string) => ({
    shells: lastCreateSessionRequest?.launchSurface === "native_tui"
      ? [{
          shellId: `agent-tui-${sessionId}`,
          sessionId,
          name: "Agent TUI",
          createdAt: 1,
          pty: true,
          kind: "agent_tui" as const,
          status: "running" as const,
          outputStartSeq: 0,
          outputEndSeq: 0,
          outputTruncated: false,
        }]
      : [],
  }),
  shellHistory: async (_sessionId: string, shellId: string) => ({
    shellId,
    chunks: [],
    nextAfter: 0,
    hasMore: false,
    truncatedBefore: false,
  }),
  resizeShell: async () => undefined,
  shellInput: async () => undefined,
  getSessionEventPage: async (sessionId: string, after = 0) => {
    sessionEventPageRequests.push({ sessionId, after });
    const available = (sessionEvents.get(sessionId) ?? []).filter((event) => event.seq > after);
    // R1.2 deliberately exposes several incomplete renders. A restored logical row can be absent
    // from the first cache page but reappear later in this same authoritative recovery chain.
    if (SCENARIO === "scroll-restore" && after > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, HISTORY_PAGE_DELAY_MS));
    }
    const events = SCENARIO === "scroll-restore" ? available.slice(0, 12) : available;
    const hasMoreCached = events.length < available.length;
    return {
      events: structuredClone(events),
      eventEpoch: model.sessions.find((candidate) => candidate.id === sessionId)?.eventEpoch ?? 0,
      nextAfter: events.at(-1)?.seq ?? after,
      hasMoreCached,
      cacheComplete: !hasMoreCached,
    };
  },
  getSessionEventTailPage: async (sessionId: string, before?: number) => {
    sessionEventPageRequests.push({ sessionId, after: before ?? 0, direction: "backward" });
    const all = sessionEvents.get(sessionId) ?? [];
    const available = before === undefined ? all : all.filter((event) => event.seq < before);
    // A bounded opening window over a much longer log: tall enough to scroll and pause inside,
    // with older turns still only reachable by paging below it.
    const windowed = SCENARIO === "scroll-restore"
      ? available.slice(before === undefined ? -24 : -12)
      : SCENARIO === "preview-opening-fill"
        ? available.slice(before === undefined ? -221 : -24)
        : available;
    if (SCENARIO === "scroll-restore" && before !== undefined) {
      await new Promise((resolve) => window.setTimeout(resolve, HISTORY_PAGE_DELAY_MS));
    }
    return {
      events: structuredClone(windowed),
      eventEpoch: model.sessions.find((candidate) => candidate.id === sessionId)?.eventEpoch ?? 0,
      ...(windowed[0] ? { nextBefore: windowed[0].seq } : {}),
      hasMoreOlder: windowed.length < available.length,
      ...(SCENARIO === "preview-opening-fill" ? { turnAligned: true } : {}),
      cacheComplete: true,
    };
  },
  podContext: async () => ({ entries: [] }),
  archiveProjectSessions: async (projectId: string) => {
    const owningProject = model.projects.find((candidate) => candidate.id === projectId);
    if (!owningProject) throw new Error("project not found");
    const archivedSessionIds = model.sessions
      .filter((candidate) => candidate.projectId === projectId && !candidate.archived)
      .map((candidate) => candidate.id);
    const changedSessions = model.sessions.filter((candidate) => archivedSessionIds.includes(candidate.id));
    for (const value of changedSessions) {
      value.archived = true;
      value.updatedAt += 1;
    }
    owningProject.unarchivedSessionCount = 0;
    owningProject.updatedAt += 1;
    saveModel();
    window.setTimeout(() => {
      for (const value of changedSessions) socket?.push({ type: "session_upsert", session: structuredClone(value) });
      socket?.push({ type: "project_upsert", project: structuredClone(owningProject) });
    }, 0);
    return {
      project: structuredClone(owningProject),
      sessions: structuredClone(model.sessions.filter((candidate) => candidate.projectId === projectId)),
      archivedSessionIds,
    };
  },
  setArchived: async (id: string, archived: boolean) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    value.archived = archived;
    value.updatedAt += 1;
    const owningProject = value.projectId ? model.projects.find((candidate) => candidate.id === value.projectId) : undefined;
    if (owningProject) {
      owningProject.unarchivedSessionCount = model.sessions.filter((candidate) => candidate.projectId === owningProject.id && !candidate.archived).length;
      owningProject.updatedAt += 1;
    }
    saveModel();
    window.setTimeout(() => {
      socket?.push({ type: "session_upsert", session: structuredClone(value) });
      if (owningProject) socket?.push({ type: "project_upsert", project: structuredClone(owningProject) });
    }, 0);
    return structuredClone(value);
  },
  setProject: async (
    id: string,
    projectId: string | null,
    options: { linkLocation?: boolean } = {},
  ) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    const previousProject = value.projectId
      ? model.projects.find((candidate) => candidate.id === value.projectId)
      : undefined;
    const nextProject = projectId ? model.projects.find((candidate) => candidate.id === projectId) : undefined;
    let nextLocation = nextProject?.locations.find((location) =>
      location.runnerId === value.runnerId && location.workspaceId === value.workspaceId);
    if (projectId && !nextProject) throw new Error("project not found");
    if (projectId && nextProject && !nextLocation) {
      if (!options.linkLocation || !value.adopted || value.importLocationReady !== true || nextProject.canManage !== true) {
        throw new Error("link this session's exact Location to the Project first");
      }
      const workspace = runner.workspaces.find((candidate) => candidate.id === value.workspaceId);
      if (!workspace) throw new Error("workspace not found");
      nextLocation = {
        id: `location-${projectId}-${workspace.id}`,
        projectId,
        runnerId: value.runnerId,
        workspaceId: workspace.id,
        name: workspace.name,
        path: workspace.path,
        source: "managed",
        availability: "available",
        isDefault: nextProject.locations.length === 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      nextProject.locations.push(nextLocation);
    }
    value.projectId = projectId;
    value.projectName = nextProject?.name ?? null;
    value.projectLocationId = nextLocation?.id ?? null;
    if (value.audience === "user" && nextProject?.audience === "team") value.audience = "team";
    value.updatedAt += 1;
    for (const project of [previousProject, nextProject]) {
      if (!project) continue;
      project.unarchivedSessionCount = model.sessions.filter((candidate) => candidate.projectId === project.id && !candidate.archived).length;
      project.totalSessionCount = model.sessions.filter((candidate) => candidate.projectId === project.id).length;
      project.updatedAt += 1;
    }
    saveModel();
    window.setTimeout(() => {
      socket?.push({ type: "session_upsert", session: structuredClone(value) });
      if (previousProject) socket?.push({ type: "project_upsert", project: structuredClone(previousProject) });
      if (nextProject && nextProject.id !== previousProject?.id) {
        socket?.push({ type: "project_upsert", project: structuredClone(nextProject) });
      }
    }, 0);
    return structuredClone(value);
  },
  createProject: async ({ name }: { name: string }) => {
    const value = project(`project-${model.projects.length + 1}`, name, { createdAt: Date.now(), updatedAt: Date.now() });
    model.projects.push(value);
    saveModel();
    window.setTimeout(() => socket?.push({ type: "project_upsert", project: structuredClone(value) }), 0);
    return { project: structuredClone(value) };
  },
  updateProject: async (id: string, patch: { name?: string; hidden?: boolean }) => {
    const value = model.projects.find((candidate) => candidate.id === id);
    if (!value) throw new Error("project not found");
    Object.assign(value, patch, { updatedAt: value.updatedAt + 1 });
    saveModel();
    window.setTimeout(() => socket?.push({ type: "project_upsert", project: structuredClone(value) }), 0);
    return { project: structuredClone(value) };
  },
  addProjectLocation: async (projectId: string, body: { runnerId: string; workspaceId: string }) => {
    const owningProject = model.projects.find((candidate) => candidate.id === projectId);
    const workspace = runner.workspaces.find((candidate) => candidate.id === body.workspaceId);
    if (!owningProject || !workspace || body.runnerId !== runner.runnerId) throw new Error("workspace not found");
    const existing = owningProject.locations.find((location) =>
      location.runnerId === body.runnerId && location.workspaceId === body.workspaceId);
    if (existing) return { project: structuredClone(owningProject) };
    const location = {
      id: `location-${projectId}-${body.workspaceId}`,
      projectId,
      runnerId: body.runnerId,
      workspaceId: body.workspaceId,
      name: workspace.name,
      path: workspace.path,
      source: "reported" as const,
      availability: "available" as const,
      isDefault: owningProject.locations.length === 0,
      activeSessionCount: 0,
      unarchivedSessionCount: 0,
      totalSessionCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    owningProject.locations.push(location);
    owningProject.updatedAt += 1;
    saveModel();
    window.setTimeout(() => socket?.push({ type: "project_upsert", project: structuredClone(owningProject) }), 0);
    return { project: structuredClone(owningProject) };
  },
  moveProjectLocation: async (targetProjectId: string, body: { locationId: string }) => {
    const target = model.projects.find((candidate) => candidate.id === targetProjectId);
    const source = model.projects.find((candidate) => candidate.locations.some((location) => location.id === body.locationId));
    const location = source?.locations.find((candidate) => candidate.id === body.locationId);
    if (!target || !source || !location) throw new Error("project location not found");
    source.locations = source.locations.filter((candidate) => candidate.id !== location.id);
    if (location.isDefault && source.locations[0]) source.locations[0].isDefault = true;
    location.projectId = target.id;
    location.isDefault = target.locations.length === 0;
    target.locations.push(location);
    for (const value of model.sessions.filter((candidate) => candidate.projectLocationId === location.id)) {
      value.projectId = target.id;
      value.updatedAt += 1;
    }
    for (const value of [source, target]) {
      value.activeSessionCount = model.sessions.filter((candidate) => candidate.projectId === value.id && !candidate.archived && ["queued", "starting", "running", "input_required"].includes(candidate.status)).length;
      value.unarchivedSessionCount = model.sessions.filter((candidate) => candidate.projectId === value.id && !candidate.archived).length;
      value.totalSessionCount = model.sessions.filter((candidate) => candidate.projectId === value.id).length;
      value.updatedAt += 1;
    }
    saveModel();
    window.setTimeout(() => {
      socket?.push({ type: "project_upsert", project: structuredClone(source) });
      socket?.push({ type: "project_upsert", project: structuredClone(target) });
      for (const value of model.sessions.filter((candidate) => candidate.projectLocationId === location.id)) {
        socket?.push({ type: "session_upsert", session: structuredClone(value) });
      }
    }, 0);
    return { project: structuredClone(target) };
  },
  removeProjectLocation: async (projectId: string, locationId: string) => {
    const owningProject = model.projects.find((candidate) => candidate.id === projectId);
    if (!owningProject) throw new Error("project not found");
    const removed = owningProject.locations.find((candidate) => candidate.id === locationId);
    if (!removed) throw new Error("project location not found");
    owningProject.locations = owningProject.locations.filter((candidate) => candidate.id !== locationId);
    if (removed.isDefault && owningProject.locations[0]) owningProject.locations[0].isDefault = true;
    owningProject.updatedAt += 1;
    saveModel();
    window.setTimeout(() => {
      socket?.push({ type: "project_upsert", project: structuredClone(owningProject) });
    }, 0);
    return { project: structuredClone(owningProject) };
  },
  setDefaultProjectLocation: async (projectId: string, locationId: string) => {
    const owningProject = model.projects.find((candidate) => candidate.id === projectId);
    if (!owningProject || !owningProject.locations.some((candidate) => candidate.id === locationId)) throw new Error("project location not found");
    for (const location of owningProject.locations) location.isDefault = location.id === locationId;
    owningProject.updatedAt += 1;
    saveModel();
    window.setTimeout(() => socket?.push({ type: "project_upsert", project: structuredClone(owningProject) }), 0);
    return { project: structuredClone(owningProject) };
  },
  deleteProject: async (projectId: string) => {
    if (!model.projects.some((candidate) => candidate.id === projectId)) throw new Error("project not found");
    model.projects = model.projects.filter((candidate) => candidate.id !== projectId);
    const changed = model.sessions.filter((candidate) => candidate.projectId === projectId);
    for (const value of changed) {
      value.projectId = null;
      value.projectLocationId = null;
      value.updatedAt += 1;
    }
    saveModel();
    window.setTimeout(() => {
      socket?.push({ type: "project_removed", projectId });
      for (const value of changed) socket?.push({ type: "session_upsert", session: structuredClone(value) });
    }, 0);
    return { deleted: true as const };
  },
  revealWorkspace: async () => ({ ok: true as const }),
} as ApiClient;

declare global {
  interface Window {
    __WOLLIPOG_PROJECT_INBOX_E2E__: {
      updateProject(id: string, patch: Partial<Pick<ProjectView, "name" | "hidden">>): void;
      updateSession(
        id: string,
        patch: Partial<Pick<SessionView,
          "projectId" | "projectName" | "projectLocationId" | "audience" | "status" | "queued" | "queueHeld" |
          "pendingApproval" | "activeTurnId" | "adopted" | "importLocationReady" | "agentCapabilities" |
          "steeringAttempts" | "preview" | "lastEventAt" | "title" | "titleSource">>,
      ): void;
      emitUserMessage(id: string, text: string, turnId: string): void;
      emitAgentMessage(id: string, text: string): void;
      emitActiveSubagent(id: string, toolCallId: string): void;
      sessionEventPageRequests(): Array<{ sessionId: string; after: number; direction?: "backward" }>;
      emitCanonicalSteeredMessage(id: string, text: string, turnId: string, submissionId: string): void;
      emitSteeringReceipt(id: string, attempt: SteeringAttemptView): void;
      setNextSteeringResult(result: SteeringFixtureResult): void;
      failNextSteeringRequest(): void;
      deferNextSteeringResult(): void;
      settleDeferredSteeringResult(result: SteeringFixtureResult): void;
      promptRequests(): PromptFixtureRequest[];
      restartRequests(): string[];
      sessionCommandRequests(): SessionCommandFixtureRequest[];
      retitleRequests(): string[];
      deferNextRetitle(): void;
      settleDeferredRetitle(result: { title?: string; error?: string }): void;
      composerDraft(id: string): Promise<ComposerDraft | null>;
      failNextSessionCommandResponse(): void;
      deferNextSessionCommandResponse(): void;
      settleDeferredSessionCommandResponse(): void;
      deferNextPrompt(): void;
      settleDeferredPrompt(): void;
      steeringRequests(): SteerRequest[];
      steeringResolutionRequests(): Array<{
        sessionId: string;
        submissionId: string;
        action: "queue_again" | "dismiss";
      }>;
      deferNextSteeringResolutions(count?: number): void;
      settleDeferredSteeringResolution(submissionId: string): void;
      deferNextCancelTurn(): void;
      settleDeferredCancelTurn(): void;
      setRunnerProtocolVersion(version: number): void;
      setRunnerStatus(status: RunnerView["status"]): void;
      pushSnapshot(): void;
      deferNextGit(id: string, action: GitFixtureAction): void;
      settleDeferredGit(id: string, action: GitFixtureAction): void;
      failNextGit(id: string, action: GitFixtureAction, message?: string): void;
      setGitUnavailable(id: string, unavailable: boolean): void;
      gitRequestCounts(id: string): { status: number; summary: number };
      setSlashCommands(
        commands: AgentSlashCommand[],
        permissionModes?: string[],
        options?: {
          supportsImages?: boolean;
          attachmentPolicy?: ProviderComposerCommand["attachmentPolicy"];
        },
      ): void;
      setSupportsSteering(id: string, supported: boolean | undefined): void;
      replaceSessionSnapshot(id: string, patch: Partial<SessionView>): void;
      replaceSnapshot(): void;
      settleInterrupted(id: string): void;
      upsertProject(project: ProjectView): void;
      removeProject(id: string): void;
      model(): FixtureModel;
      lastCreateSessionRequest(): CreateSessionRequest | null;
      terminalOpenCount(): number;
      cancelTurnCount(): number;
      failNextCancelTurn(): void;
      seedQueuedEditRecovery(sessionId: string, recovery: QueuedPromptEditRecovery): void;
    };
  }
}

window.__WOLLIPOG_PROJECT_INBOX_E2E__ = {
  updateProject(id, patch) {
    const value = model.projects.find((candidate) => candidate.id === id);
    if (!value) throw new Error(`unknown Project: ${id}`);
    Object.assign(value, patch, { updatedAt: value.updatedAt + 1 });
    saveModel();
    socket?.push({ type: "project_upsert", project: structuredClone(value) });
  },
  retitleRequests: () => structuredClone(retitleRequests),
  deferNextRetitle() {
    deferNextRetitleRequest = true;
  },
  settleDeferredRetitle(result) {
    if (!pendingRetitleSettlement) throw new Error("no deferred retitle request");
    pendingRetitleSettlement(result);
  },
  updateSession(id, patch) {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error(`unknown session: ${id}`);
    Object.assign(value, patch, { updatedAt: value.updatedAt + 1 });
    saveModel();
    socket?.push({ type: "session_upsert", session: structuredClone(value) });
  },
  emitUserMessage(id, text, turnId) {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error(`unknown session: ${id}`);
    const seq = value.messageCount + 1;
    value.messageCount = seq;
    value.updatedAt += 1;
    value.lastEventAt = value.updatedAt;
    const event: SessionEvent = {
      id: seq,
      sessionId: id,
      seq,
      ts: value.updatedAt,
      payload: { kind: "user_message", text, turnId },
    };
    sessionEvents.set(id, [...(sessionEvents.get(id) ?? []), event]);
    socket?.push({ type: "session_event", event: structuredClone(event) });
    pushSession(value);
  },
  emitAgentMessage(id, text) {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error(`unknown session: ${id}`);
    const seq = value.messageCount + 1;
    value.messageCount = seq;
    value.updatedAt += 1;
    value.lastEventAt = value.updatedAt;
    const event: SessionEvent = {
      id: seq,
      sessionId: id,
      seq,
      ts: value.updatedAt,
      payload: {
        kind: "agent_message",
        text,
        final: true,
        messageId: `streamed-preview-message-${seq}`,
      },
    };
    sessionEvents.set(id, [...(sessionEvents.get(id) ?? []), event]);
    socket?.push({ type: "session_event", event: structuredClone(event) });
    pushSession(value);
  },
  emitActiveSubagent(id, toolCallId) {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error(`unknown session: ${id}`);
    const seq = value.messageCount + 1;
    value.messageCount = seq;
    value.updatedAt += 1;
    value.lastEventAt = value.updatedAt;
    const event: SessionEvent = {
      id: seq,
      sessionId: id,
      seq,
      ts: value.updatedAt,
      payload: {
        kind: "tool_call",
        toolCallId,
        title: "Background Agent",
        text: "",
        toolKind: "agent",
        status: "in_progress",
        subagentLifecycle: "running",
      },
    };
    sessionEvents.set(id, [...(sessionEvents.get(id) ?? []), event]);
    socket?.push({ type: "session_event", event: structuredClone(event) });
    pushSession(value);
  },
  sessionEventPageRequests: () => structuredClone(sessionEventPageRequests),
  emitCanonicalSteeredMessage(id, text, turnId, submissionId) {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error(`unknown session: ${id}`);
    pushCanonicalSteeredMessage(value, text, turnId, submissionId);
    pushSession(value);
  },
  emitSteeringReceipt(id, attempt) {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error(`unknown session: ${id}`);
    upsertSteeringAttempt(value, attempt);
    pushSession(value);
  },
  setNextSteeringResult(result) {
    nextSteeringResult = structuredClone(result);
  },
  failNextSteeringRequest() {
    failNextSteeringRequest = true;
  },
  deferNextSteeringResult() {
    if (pendingSteeringSettlement) throw new Error("a steering result is already deferred");
    deferNextSteeringResult = true;
  },
  settleDeferredSteeringResult(result) {
    if (!pendingSteeringSettlement) throw new Error("no steering result is awaiting settlement");
    pendingSteeringSettlement(structuredClone(result));
  },
  promptRequests: () => structuredClone(promptRequests),
  restartRequests: () => structuredClone(restartRequests),
  sessionCommandRequests: () => structuredClone(sessionCommandRequests),
  composerDraft: (id) => loadComposerDraft(id, "project-inbox-e2e"),
  failNextSessionCommandResponse() {
    failNextSessionCommandResponse = true;
  },
  deferNextSessionCommandResponse() {
    if (pendingSessionCommandSettlement) throw new Error("a session command response is already deferred");
    deferNextSessionCommandResponse = true;
  },
  settleDeferredSessionCommandResponse() {
    if (!pendingSessionCommandSettlement) throw new Error("no session command response is awaiting settlement");
    pendingSessionCommandSettlement();
  },
  deferNextPrompt() {
    if (pendingPromptSettlement) throw new Error("a prompt is already deferred");
    deferNextPromptRequest = true;
  },
  settleDeferredPrompt() {
    if (!pendingPromptSettlement) throw new Error("no prompt is awaiting settlement");
    pendingPromptSettlement();
  },
  steeringRequests: () => structuredClone(steeringRequests),
  steeringResolutionRequests: () => structuredClone(steeringResolutionRequests),
  deferNextSteeringResolutions(count = 1) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("deferred resolution count must be positive");
    deferredSteeringResolutionCount += count;
  },
  settleDeferredSteeringResolution(submissionId) {
    const settle = pendingSteeringResolutionSettlements.get(submissionId);
    if (!settle) throw new Error(`no steering resolution is awaiting settlement: ${submissionId}`);
    settle();
  },
  deferNextCancelTurn() {
    if (pendingCancelTurnSettlement) throw new Error("a cancel turn request is already deferred");
    deferNextCancelTurnRequest = true;
  },
  settleDeferredCancelTurn() {
    if (!pendingCancelTurnSettlement) throw new Error("no cancel turn request is awaiting settlement");
    pendingCancelTurnSettlement();
  },
  setRunnerProtocolVersion(version) {
    runner.protocolVersion = version;
    socket?.push(snapshot());
  },
  setRunnerStatus(status) {
    runner.status = status;
    socket?.push(snapshot());
  },
  pushSnapshot() {
    socket?.push(snapshot());
  },
  deferNextGit(id, action) {
    const key = gitRequestKey(id, action);
    if ((pendingGitRequests.get(key)?.length ?? 0) > 0) throw new Error(`a Git request is already pending: ${key}`);
    deferredGitRequests.add(key);
  },
  settleDeferredGit(id, action) {
    const key = gitRequestKey(id, action);
    const settlements = pendingGitRequests.get(key);
    if (!settlements?.length) throw new Error(`no Git request is awaiting settlement: ${key}`);
    heldGitSessions.delete(id);
    pendingGitRequests.delete(key);
    for (const settle of settlements) settle();
  },
  failNextGit(id, action, message = "Simulated Git status failure") {
    failingGitRequests.set(gitRequestKey(id, action), message);
  },
  setGitUnavailable(id, unavailable) {
    if (unavailable) unavailableGitSessions.add(id);
    else unavailableGitSessions.delete(id);
  },
  gitRequestCounts(id) {
    return structuredClone(gitRequestCounts.get(id) ?? { status: 0, summary: 0 });
  },
  setSlashCommands(commands, permissionModes = [], options = {}) {
    const capabilities = runner.agents[0]!.capabilities;
    fixtureProviderCommandAttachmentPolicy = options.attachmentPolicy ?? "send";
    updateFixtureProviderCommandAttachmentPolicy?.(fixtureProviderCommandAttachmentPolicy);
    runner.agents[0]!.capabilities = {
      ...capabilities,
      models: capabilities?.models ?? [],
      effortLevels: capabilities?.effortLevels ?? [],
      supportsImages: options.supportsImages ?? capabilities?.supportsImages ?? false,
      supportsApprovals: capabilities?.supportsApprovals ?? true,
      slashCommands: structuredClone(commands),
      permissionModes: [...permissionModes],
    };
    socket?.push(snapshot());
  },
  setSupportsSteering(id, supported) {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error(`unknown session: ${id}`);
    const sessionCapabilities: SessionCapabilityOverlay = { ...value.agentCapabilities };
    if (supported === undefined) delete sessionCapabilities.supportsSteering;
    else sessionCapabilities.supportsSteering = supported;
    value.agentCapabilities = sessionCapabilities;
    runner.agents[0]!.capabilities = {
      models: [],
      effortLevels: [],
      slashCommands: [{ name: "review", source: "builtin", description: "Review the current changes" }],
      supportsImages: false,
      supportsApprovals: true,
      ...(supported === undefined ? {} : { supportsSteering: supported }),
    };
    socket?.push(snapshot());
  },
  replaceSessionSnapshot(id, patch) {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error(`unknown session: ${id}`);
    Object.assign(value, structuredClone(patch));
    saveModel();
    socket?.push(snapshot());
  },
  replaceSnapshot() {
    socket?.push(snapshot());
  },
  settleInterrupted(id) {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error(`unknown session: ${id}`);
    const seq = value.messageCount + 1;
    value.messageCount = seq;
    value.status = "idle";
    value.queueHeld = true;
    value.activeTurnId = undefined;
    value.updatedAt += 1;
    value.lastEventAt = value.updatedAt;
    saveModel();
    socket?.push({
      type: "session_event",
      event: { id: seq, sessionId: id, seq, ts: value.updatedAt, payload: { kind: "turn_interrupted" } },
    });
    socket?.push({ type: "session_upsert", session: structuredClone(value) });
  },
  upsertProject(project) {
    const index = model.projects.findIndex((candidate) => candidate.id === project.id);
    if (index === -1) model.projects.push(structuredClone(project));
    else model.projects[index] = structuredClone(project);
    saveModel();
    socket?.push({ type: "project_upsert", project: structuredClone(project) });
  },
  removeProject(id) {
    model.projects = model.projects.filter((candidate) => candidate.id !== id);
    saveModel();
    socket?.push({ type: "project_removed", projectId: id });
  },
  model: () => structuredClone(model),
  lastCreateSessionRequest: () => structuredClone(lastCreateSessionRequest),
  terminalOpenCount: () => terminalOpenCount,
  cancelTurnCount: () => cancelTurnCount,
  failNextCancelTurn: () => {
    failNextCancelTurn = true;
  },
  seedQueuedEditRecovery(sessionId, recovery) {
    const saved = saveDurableQueuedEditRecovery({
      instanceScope: "project-inbox-e2e",
      accountKey: queuedEditRecoveryAccountKey("fixture-organization", "fixture-user"),
      sessionId,
    }, recovery);
    if (!saved) throw new Error("queued edit recovery was not saved");
  },
};

function FixtureSurface() {
  const rightPanel = useRightPanelState();
  const view = useStoreSelector((state) => state.view);
  const sessions = useStoreSelector((state) => state.sessions);
  const isMobile = useIsMobile();
  const [providerCommandAttachmentPolicy, setProviderCommandAttachmentPolicy] = useState(
    fixtureProviderCommandAttachmentPolicy,
  );
  updateFixtureProviderCommandAttachmentPolicy = setProviderCommandAttachmentPolicy;
  const [newSession, setNewSession] = useState<{ preset?: NewSessionPreset } | null>(null);
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const shortcutPresetRef = useRef<NewSessionPreset | undefined>(undefined);
  const openNewSession = useCallback((preset?: NewSessionPreset) => setNewSession({ preset }), []);
  const openShortcutSession = useCallback(() => openNewSession(shortcutPresetRef.current), [openNewSession]);
  const setShortcutPreset = useCallback((preset?: NewSessionPreset) => {
    shortcutPresetRef.current = preset;
  }, []);
  const openTerminal = useCallback(() => {
    terminalOpenCount += 1;
    setTerminalSessionId(model.sessions.at(-1)?.id ?? null);
  }, []);
  useNewSessionShortcut(true, openShortcutSession);
  const mobileSessionShell = INCLUDE_SESSION_SHELL && isMobile && view.name === "session" ? (
    <Header
      view={view}
      mobileInstanceControl={<button type="button" className="instance-selector-trigger" aria-label="Switch Instance">I</button>}
      onNewRun={() => undefined}
      onNewPod={() => undefined}
      sessionActions={(
        <>
          <button type="button" className="icon-btn" aria-label="Toggle Pinned Summary">P</button>
          <button type="button" className="icon-btn" aria-label="Show Terminal">T</button>
          <button type="button" className="icon-btn" aria-label="Show Side Panel">F</button>
        </>
      )}
      sessionTitle={sessions.get(view.id)?.title ?? "Session"}
      onSessionBack={() => undefined}
    />
  ) : null;
  if (view.name === "projects") {
    return (
      <>
        <ProjectsView selectedProjectId={view.id} onNewSession={openNewSession} />
        {newSession && (
          <NewSessionDialog
            preset={newSession.preset}
            onClose={() => setNewSession(null)}
            onOpenTerminal={openTerminal}
          />
        )}
      </>
    );
  }
  if (view.name === "session" && SCENARIO !== "conversation-steering" &&
      SCENARIO !== "preview-follow" && SCENARIO !== "preview-opening-fill") {
    return (
      <>
        {mobileSessionShell}
        <SessionDetail
          sessionId={view.id}
          mode="expanded"
          rightPanel={rightPanel}
          onOpenTerminal={openTerminal}
          pinnedOpen={SCENARIO === "git-visibility"}
          providerCommandAttachmentPolicy={providerCommandAttachmentPolicy}
        />
        {terminalSessionId === view.id && (
          <ShellDock
            sessionId={view.id}
            onClose={() => setTerminalSessionId(null)}
            theme="dark" scheme="wollipog"
          />
        )}
      </>
    );
  }
  if (view.name === "pod") return <PodDetail podId={view.id} />;
  if (view.name === "run") return <RunDetail runId={view.id} />;
  if (view.name !== "inbox" && view.name !== "session") return <div>Fixture View: {view.name}</div>;
  return (
    <>
      {mobileSessionShell}
      <InboxView
        expandedSessionId={view.name === "session" ? view.id : null}
        rightPanel={rightPanel}
        onOpenTerminal={openTerminal}
        pinnedOpen={SCENARIO === "git-visibility"}
        onNewSession={openNewSession}
        onShortcutNewSessionPresetChange={setShortcutPreset}
      />
      {view.name === "session" && terminalSessionId === view.id && (
        <ShellDock
          sessionId={view.id}
          onClose={() => setTerminalSessionId(null)}
          theme="dark" scheme="wollipog"
        />
      )}
      {newSession && (
        <NewSessionDialog
          preset={newSession.preset}
          onClose={() => setNewSession(null)}
          onOpenTerminal={openTerminal}
        />
      )}
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <InstanceScopeProvider instanceScope="project-inbox-e2e">
      <ApiProvider client={client}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}>
            <FixtureSurface />
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>
    </InstanceScopeProvider>
  </React.StrictMode>,
);
