import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  PROTOCOL_VERSION,
  buildConversationHandoff,
  type AgentCapabilities,
  type AgentSlashCommand,
  type CreateSessionRequest,
  type CreateWorkspaceReferenceRequest,
  type ControlPlaneToUi,
  type DescendantRequestView,
  type TeamView,
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
  type WorkspaceReference,
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
import { FeedbackProvider, useFeedback, type ToastOptions } from "../components/FeedbackProvider.js";
import { DockBottomIcon, PanelRightIcon, PinnedPanelIcon } from "../components/Icons.js";
import { InboxView } from "../components/InboxView.js";
import { NewSessionDialog, type NewSessionPreset } from "../components/NewSessionDialog.js";
import { PodDetail } from "../components/PodsView.js";
import { ProjectsView } from "../components/ProjectsView.js";
import { RunDetail } from "../components/RunsView.js";
import { SessionDetail } from "../components/SessionDetail.js";
import { ShellDock } from "../components/ShellDock.js";
import { useRightPanelState } from "../components/RightPanel.js";
import { useIsMobile } from "../components/useIsMobile.js";
import { Header, Shell } from "../App.js";
import { sessionDisplayTitle } from "../session-title.js";
import { ThemeProvider } from "../components/ThemeProvider.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import { browserInstanceManager, InstancesContextProvider } from "../instances-context.js";
import { viewFromPath, viewPath, type ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { useNewSessionShortcut } from "../useNewSessionShortcut.js";
import "../styles.css";
import { staticPinnedSummary } from "../components/pinned-summary-state.js";

const FIXTURE_QUERY = new URLSearchParams(window.location.search);
const SCENARIO = FIXTURE_QUERY.get("scenario");
/** Scenarios that show the Pinned Summary open without the app shell's toggle. */
const STATIC_SUMMARY_OPEN = SCENARIO === "git-visibility" || SCENARIO === "worktree-identity" ||
  SCENARIO === "unsafe-worktree-pr";
const REVIEW_READY = FIXTURE_QUERY.get("reviewReady") === "1";
const INCLUDE_SESSION_SHELL = FIXTURE_QUERY.get("sessionShell") === "1";
const LEGACY_WORKSPACES = FIXTURE_QUERY.get("legacyWorkspaces") === "1";
const UNFILED_WORKSPACE = FIXTURE_QUERY.get("unfiledWorkspace") === "1";
const LONG_AGENT = FIXTURE_QUERY.get("longAgent") === "1";
const SESSION_REMINDERS = FIXTURE_QUERY.get("reminders") === "1";
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
      // #782: line three is unconditional, so the scenario has to carry every combination of branch
      // state and background work — that product is exactly what used to make cards two, three, or
      // four lines tall. Appended, so the indices the #664 and #679 assertions use are untouched.
      ["session-no-branch-waiting", "No Branch, Waiting on an External Job", {
        backgroundWorkState: "running",
      }],
      ["session-branch-waiting", "A Long Branch and a Badge on the Same Line", {
        useWorktree: true,
        worktreePath: "/repos/alpha/.agent-worktrees/waiting",
        worktrees: [{
          id: "wt-waiting",
          path: "/repos/alpha/.agent-worktrees/waiting",
          branch: "fix/issue-782-keep-every-session-card-at-three-rows-and-always-show-git-branch-state",
          baseRef: "release/2027-q1-hardening-of-the-inbox-virtualisation-and-activity-strip-measurement-path",
          source: "created",
          pullRequest: { url: "https://github.com/picoduck/wollipog/pull/782", state: "open" },
        }],
        backgroundWorkState: "running",
      }],
      // An active worktree the inventory never described: honest "Branch Unavailable", not "No Branch".
      ["session-branch-unknown", "Worktree Held, Branch Never Reported", {
        useWorktree: true,
        worktreePath: "/repos/alpha/.agent-worktrees/unreported",
        backgroundWorkState: "continuation_pending",
      }],
      ["session-orphaned", "Orphaned Background Work Beside a Branch", {
        useWorktree: true,
        worktreePath: "/repos/alpha/.agent-worktrees/orphaned",
        worktrees: [{
          id: "wt-orphaned",
          path: "/repos/alpha/.agent-worktrees/orphaned",
          branch: "fix/issue-782-orphaned",
          source: "created",
        }],
        backgroundWorkState: "orphaned",
      }],
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
  if (SCENARIO === "conversation-handoff") {
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      status: "idle", activeTurnId: null, useWorktree: true, worktreePath: "/repos/alpha/checkpoint",
      // A deliberate non-default tier that the destination model below does not advertise, so the
      // dialog must say so rather than substitute a default.
      serviceTier: "flex",
    });
  }
  if (SCENARIO === "edit-in-fork") {
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      status: "idle", activeTurnId: null, useWorktree: true, worktreePath: "/repos/alpha/checkpoint",
    });
  }
  if (SCENARIO === "history-quarantine" || SCENARIO === "history-quarantine-handoff" ||
      SCENARIO === "session-notices") {
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      status: "idle", activeTurnId: null, useWorktree: true, worktreePath: "/repos/alpha/checkpoint",
      model: "gpt-5", effort: "high",
      historyQuarantine: {
        reason: "oversized_tool_call", detectedAt: 1,
        recoveryTurn: 1, recovery: SCENARIO === "history-quarantine-handoff" ? "handoff" : "fork",
        ...(SCENARIO === "history-quarantine-handoff" ? {} : { retainedPrompt: true }),
      },
    });
  }
  if (SCENARIO === "session-notices") {
    // Three problem states at once (#1966): the slot shows the quarantine, the rest behind +2 More.
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      providerAccountId: "acct-personal",
      providerAccountLabel: "Personal",
      providerAccountSwitchFailure: {
        providerAccountId: "acct-work",
        providerAccountLabel: "work@example.com",
        reason: "the provider conversation cannot be resumed under another account",
        detectedAt: 2,
      },
      worktrees: [{
        id: "wt-checkpoint", path: "/repos/alpha/checkpoint", branch: "agent/alpha", baseRef: "origin/main",
        baseCommit: "a".repeat(40), source: "created",
        setup: {
          status: "failed", configHash: "b".repeat(64), attemptId: "attempt-1", environmentKeys: [], copies: [],
          steps: [{ name: "Install Dependencies", status: "failed", optional: false, startedAt: 1, durationMs: 902, error: "exited with 1" }],
          error: "Install Dependencies exited with 1",
        },
      }],
    });
  }
  if (SCENARIO === "invalid-setup-config") {
    // An invalid setup configuration and a failed account switch at once (#2036): the slot shows
    // the configuration, the account switch behind +1 More.
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      status: "failed", activeTurnId: null, useWorktree: true, worktreePath: "/repos/alpha/checkpoint",
      providerAccountId: "acct-personal",
      providerAccountLabel: "Personal",
      providerAccountSwitchFailure: {
        providerAccountId: "acct-work",
        providerAccountLabel: "work@example.com",
        reason: "the provider conversation cannot be resumed under another account",
        detectedAt: 2,
      },
      worktrees: [{
        id: "wt-checkpoint", path: "/repos/alpha/checkpoint", branch: "agent/alpha", baseRef: "origin/main",
        baseCommit: "a".repeat(40), source: "created",
        setupConfig: { status: "invalid", error: ".wollipog.json.version must be 1" },
      }],
    });
  }
  if (SCENARIO === "composer-restart") {
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      status: "stopped",
      activeTurnId: null,
    });
  }
  if (SCENARIO === "session-usage-escape") {
    // Recorded usage and a served window, so the status strip shows the cost chip and context ring.
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      tokensIn: 40_000, tokensOut: 900, costUsd: 0.42, contextTokensUsed: 40_000, contextWindow: 258_000,
    });
  }
  if (SCENARIO === "git-visibility") {
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      useWorktree: true,
      worktreePath: "/repos/alpha/.agent-worktrees/session-alpha",
    });
  }
  if (SCENARIO === "pinned-summary") {
    // Every fact the session bar used to carry, now stated once in the Pinned Summary (#2160).
    Object.assign(initial.sessions.find((candidate) => candidate.id === "session-alpha")!, {
      useWorktree: true,
      worktreePath: "/repos/alpha/.agent-worktrees/session-alpha",
      worktrees: [{
        id: "wt-session-alpha",
        path: "/repos/alpha/.agent-worktrees/session-alpha",
        branch: "feature/session-alpha-with-a-deliberately-long-branch-name-for-narrow-layout-validation",
        baseRef: "origin/main",
        source: "created",
        pullRequest: { url: "https://github.com/example/wollipog/pull/318", state: "open" },
      }],
      providerAccountId: "account-alpha",
      providerAccountLabel: "pat.example@example.com",
      providerAccountAutomaticallySelected: true,
      backgroundWorkTracking: "untracked",
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
      pr: (SCENARIO === "git-visibility" || SCENARIO === "pinned-summary") && value.id === "session-alpha"
        ? { number: 318, title: "Alpha Visibility PR", url: "https://github.com/example/wollipog/pull/318", state: "OPEN" }
        : null,
      checks: SCENARIO === "pinned-summary" && value.id === "session-alpha"
        ? {
            failing: 2,
            pending: 0,
            passing: 9,
            failingNames: ["Typecheck, Test & Sidecar Bundle", "Browser End-to-End Tests"],
            url: "https://github.com/example/wollipog/pull/318/checks",
          }
        : null,
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
/** Handoff requests the fixture observed, so a spec can prove which config actually crossed the
 * boundary rather than inferring it from the resulting session. */
const handoffRequests: Array<{ id: string; turn: number; agentId: string; config: SessionConfig }> = [];
/** Recovery requests the fixture observed, so a spec can prove the client asked for the recorded
 * safe checkpoint and never submitted a prompt into the quarantined conversation. */
const recoveryRequests: Array<{ id: string; turn: number; handoff?: { agentId: string; config: SessionConfig } }> = [];
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
if (SCENARIO === "history-quarantine" || SCENARIO === "history-quarantine-handoff" || SCENARIO === "session-notices") {
  sessionEvents.set("session-alpha", [
    { id: 1, sessionId: "session-alpha", seq: 1, ts: 1, payload: { kind: "user_message", text: "Summarize the release notes.", final: true } },
    { id: 2, sessionId: "session-alpha", seq: 2, ts: 2, payload: { kind: "agent_message", text: "Summarized the release notes.", final: true } },
    { id: 3, sessionId: "session-alpha", seq: 3, ts: 3, payload: { kind: "conversation_checkpoint", turn: 1 } },
    { id: 4, sessionId: "session-alpha", seq: 4, ts: 4, payload: { kind: "user_message", text: "Now scan every changed file.", final: true } },
    { id: 5, sessionId: "session-alpha", seq: 5, ts: 5, payload: { kind: "error", message: "The agent provider rejected this conversation's stored history: the recorded tool call at history position 675 cannot be resent. Its arguments field is 1,426,210 characters, over the provider's limit of 1,048,576." } },
  ]);
}
if (SCENARIO === "conversation-handoff") {
  sessionEvents.set("session-alpha", [
    { id: 1, sessionId: "session-alpha", seq: 1, ts: 1, payload: { kind: "user_message", text: "Keep the interface accessible on mobile.", final: true } },
    { id: 2, sessionId: "session-alpha", seq: 2, ts: 2, payload: { kind: "checkpoint", turn: 1, tree: "tree-before-turn" } },
    { id: 3, sessionId: "session-alpha", seq: 3, ts: 3, payload: { kind: "agent_message", text: "The checkpoint preserves the accessible layout.", final: true } },
    { id: 4, sessionId: "session-alpha", seq: 4, ts: 4, payload: { kind: "conversation_checkpoint", turn: 1 } },
  ]);
}
if (SCENARIO === "edit-in-fork") {
  // Two completed turns, so the second message has a checkpoint to edit from and the first has none.
  sessionEvents.set("session-alpha", [
    { id: 1, sessionId: "session-alpha", seq: 1, ts: 1, payload: { kind: "user_message", text: "Draft the release notes.", final: true } },
    { id: 2, sessionId: "session-alpha", seq: 2, ts: 2, payload: { kind: "agent_message", text: "Drafted the release notes.", final: true } },
    { id: 3, sessionId: "session-alpha", seq: 3, ts: 3, payload: { kind: "conversation_checkpoint", turn: 1 } },
    { id: 4, sessionId: "session-alpha", seq: 4, ts: 4, payload: { kind: "user_message", text: "Shorten them to five bullets.", final: true } },
    { id: 5, sessionId: "session-alpha", seq: 5, ts: 5, payload: { kind: "agent_message", text: "Shortened the release notes.", final: true } },
    { id: 6, sessionId: "session-alpha", seq: 6, ts: 6, payload: { kind: "conversation_checkpoint", turn: 2 } },
  ]);
}
if (SCENARIO === "pinned-summary") {
  // The content a floating summary used to cover (#2147): a table as wide as the reading column,
  // with its last column at the right edge, and code blocks whose Copy Code sits top right.
  const table = [
    "| Area | Owner | Status | Opened | Updated | Next Step | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...["Session bar", "Pinned Summary", "Notice slot", "Composer", "Right panel"].map((area, index) =>
      `| ${area} | Platform | In review | 2026-09-0${index + 1} | 2026-09-2${index} | Ship behind the frame epic | Last column reaches the edge ${index + 1} |`),
  ].join("\n");
  const code = (name: string) => [
    "```ts",
    `export function ${name}(width: number): boolean {`,
    "  return width >= 840; // the reader keeps 560px beside a 280px summary",
    "}",
    "```",
  ].join("\n");
  sessionEvents.set("session-alpha", [
    { id: 1, sessionId: "session-alpha", seq: 1, ts: 1, payload: { kind: "user_message", text: "Show me the frame status and the docking check.", final: true } },
    { id: 2, sessionId: "session-alpha", seq: 2, ts: 2, payload: { kind: "agent_message", text: `Here is the status of each area.\n\n${table}\n\nThe docking check:\n\n${code("docks")}\n\nAnd the drawer check:\n\n${code("drawerOpens")}`, final: true } },
    { id: 3, sessionId: "session-alpha", seq: 3, ts: 3, payload: { kind: "conversation_checkpoint", turn: 1 } },
    ...(FIXTURE_QUERY.get("psActivity") === "1" ? ([
      { id: 4, sessionId: "session-alpha", seq: 4, ts: 4, payload: { kind: "plan", entries: [
        { content: "Read the summary's facts", status: "completed" },
        { content: "Rebuild the rows", status: "in_progress" },
        { content: "Capture the evidence", status: "pending" },
      ] } },
      { id: 5, sessionId: "session-alpha", seq: 5, ts: 5, payload: { kind: "tool_call", toolCallId: "ps-read", title: "Read PinnedSummary.tsx", toolKind: "read", status: "completed" } },
      { id: 6, sessionId: "session-alpha", seq: 6, ts: 6, payload: { kind: "tool_call", toolCallId: "ps-test", title: "Run the summary tests", toolKind: "execute", status: "failed" } },
      { id: 7, sessionId: "session-alpha", seq: 7, ts: 7, payload: { kind: "file_edit", path: "apps/web/src/components/PinnedSummary.tsx" } },
      { id: 8, sessionId: "session-alpha", seq: 8, ts: 8, payload: { kind: "file_edit", path: "apps/web/src/styles.css" } },
    ] satisfies SessionEvent[]) : []),
  ]);
}
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
let orchestratorRoleSupported = false;
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
    name: LONG_AGENT ? "Áccented Agent With Descenders ģyq — Extended Name" : "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: LONG_AGENT ? "acp" : "codex-app-server",
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
if (SCENARIO === "conversation-handoff") runner.agents.push({
  id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code",
  authStatus: "authenticated", available: true,
  capabilities: { models: [{ id: "opus", displayName: "Opus", inputModalities: ["text", "image"],
      serviceTiers: [{ id: "priority", name: "Priority" }] }],
    effortLevels: ["high"], permissionModes: ["default", "plan"], supportsImages: true, supportsApprovals: true, slashCommands: [] },
});

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
      ...(SESSION_REMINDERS ? { sessionReminders: true } : {}),
      ...(orchestratorRoleSupported ? { orchestratorRole: true } : {}),
    },
    runners: SHELL_SKILLS_MODE === "detail" ? [runner, secondSkillRunner]
      : SHELL_SKILLS_MODE === "notices" ? [noticeStudio, noticeLaptop]
      : shellOfflineRunner ? [runner, shellOfflineRunner] : [runner],
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

/**
 * `?offlineBanner=1` loses the connection once the snapshot has landed and never gets it back, so the
 * shell keeps the snapshot and shows its offline page banner above the page (#2105). Every later
 * socket stays connecting.
 */
const OFFLINE_BANNER = FIXTURE_QUERY.get("offlineBanner") === "1";
let offlineBannerLost = false;

class NeverOpenSocket implements UiSocket {
  readonly readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "project-inbox-e2e",
  runtimeKey: "project-inbox-e2e:1",
  createSocket() {
    if (offlineBannerLost) return new NeverOpenSocket();
    const opened = new FixtureSocket();
    socket = opened;
    if (OFFLINE_BANNER) {
      // After the snapshot, and only for a socket the store still holds: StrictMode's first mount
      // detaches its socket's handlers, and losing that one would lose nothing.
      window.setTimeout(() => {
        if (!opened.onclose || offlineBannerLost) return;
        offlineBannerLost = true;
        opened.onclose({ code: 1006 });
      }, 50);
    }
    return opened;
  },
  close() {},
};

const navigation: ViewNavigation = {
  current: () => {
    const fixtureView = new URLSearchParams(window.location.search).get("view");
    if (fixtureView === "pod") return { name: "pod", id: activePod.id };
    if (fixtureView === "run") return { name: "run", id: activeRun.id };
    // `?fullShell=1&path=/skills` opens any destination in the real Shell.
    const fixturePath = new URLSearchParams(window.location.search).get("path");
    return (fixturePath ? viewFromPath(fixturePath) : null) ?? { name: "inbox" };
  },
  // `&history=1` makes navigation real history (#1947): a push rewrites `path=` in a new entry, and
  // the browser's Back returns to the previous one.
  push(view) {
    if (FIXTURE_QUERY.get("history") !== "1") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    url.searchParams.set("path", viewPath(view));
    window.history.pushState(null, "", url);
  },
  listen(onView) {
    if (FIXTURE_QUERY.get("history") !== "1") return () => {};
    const listener = () => onView(navigation.current());
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  },
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

let descendantRequestRows: DescendantRequestView[] = [];
let descendantRequestCallCount = 0;
let deferNextDescendantRequest = false;
let failNextDescendantRequest = false;
let pendingDescendantRequestSettlement: (() => void) | null = null;

function descendantRequestFixture(): DescendantRequestView {
  return {
    sessionId: "session-descendant-request",
    sessionTitle: "Descendant Request Fixture",
    runnerId: runner.runnerId,
    runnerOnline: true,
    eventEpoch: 1,
    createdAt: Date.now(),
    responseOwner: "human",
    occurrenceId: "descendant-request-occurrence",
    request: {
      requestId: "descendant-request-question",
      occurrenceId: "descendant-request-occurrence",
      kind: "question",
      title: "Question",
      options: [],
      questions: [{ id: "next", question: "What should happen next?", options: [] }],
    },
  };
}

/**
 * Agent Skills in the real Shell (#1947). `?skills=` picks the library: the default is a small one
 * whose first skill has a SKILL.md long enough to scroll and an assignments table as its widest
 * child; `many` has 40 skills, so the list scrolls on its own; `empty`, `loading` and `error` are the
 * §12 states.
 */
const SHELL_SKILLS_MODE = FIXTURE_QUERY.get("skills");
const SHELL_SKILL_NAMES = ["code-review", "release-notes", "triage-helper", "using-wollipog", "dependency-audit", "writing-tests"];
/**
 * `list` (#1961): descriptions that are empty, 20 characters, the built-in `orchestrate-issues`
 * description and 1,024 characters with line breaks, one equal to its name, and every attention
 * state (a failed link, an edited copy, a held Git update), a Platform group and orphaned copies.
 */
const SHELL_LIST_GIT_SOURCE = { url: "https://github.com/example/skills.git", ref: "main", subdirectory: "lint-rules", path: "lint-rules", commit: "4c1d".padEnd(40, "0") };
const SHELL_LIST_LONG_END = "\nFinally, it archives the run.";
const SHELL_LIST_LONG = Array.from({ length: 16 }, (_, index) =>
  `Step ${index + 1}: read the whole change, then check it against the team's written conventions.`)
  .join("\n").slice(0, 1_024 - SHELL_LIST_LONG_END.length) + SHELL_LIST_LONG_END;
const SHELL_LIST_SKILLS = [
  { name: "orchestrate-issues", description: "Coordinate explicitly requested Wollipog child-session issue campaigns through merge, cleanup, recursive follow-ups, and archival. Use only when the user invokes this skill or explicitly asks to orchestrate or delegate issue implementation across sessions. A request to claim, implement, or fix multiple issues alone stays in the current session and does not trigger this skill. Do not trigger merely because the issues concern Orchestrator features.",
    builtIn: { release: "0.29.1", heldUpdate: null }, recommendation: { dismissed: false }, assignmentCount: 0 },
  { name: "using-wollipog", description: "Operate Wollipog sessions from inside an agent session.", builtIn: { release: "0.29.1", heldUpdate: null },
    recommendation: { dismissed: true }, assignmentCount: 0 },
  { name: "code-review", description: "", assignmentCount: 1 },
  { name: "deploy-bot", description: "Ships signed builds", assignmentCount: 1, groupId: "group-platform" },
  { name: "review-checklist", description: SHELL_LIST_LONG, assignmentCount: 1 },
  { name: "release-notes", description: "Writes release notes from merged pull requests.", assignmentCount: 1 },
  { name: "lint-rules", description: "Keeps the team's lint rules current.", assignmentCount: 2, groupId: "group-platform",
    gitSource: SHELL_LIST_GIT_SOURCE,
    gitAutoUpdate: { enabled: true, held: { commit: "9e2a".padEnd(40, "0"), reason: "scripts" as const, scriptPaths: ["scripts/fix.sh"], heldAt: 1_700_000_000_000 } } },
  { name: "qa", description: "QA", assignmentCount: 0 },
].map((skill, index) => ({
  id: `skill-${index + 1}`,
  latestVersion: { id: `v${index + 1}`, digest: `${(index + 1).toString(16).padStart(4, "0")}`.padEnd(64, "a"), createdAt: 1_700_000_000_000 },
  ...skill,
}));
const shellListTarget = (name: string) => ({ name, versionDigest: "d1", targets: [{ agentId: "codex", invocation: "agent" as const }] });
const SHELL_LIST_MACHINE = {
  removalReporting: "supported" as const, driftReporting: "supported" as const, keptAsideReporting: "supported" as const,
  desired: ["deploy-bot", "release-notes", "code-review", "review-checklist", "lint-rules"].map(shellListTarget),
  reported: {
    deployed: [
      { name: "deploy-bot", digest: "d1", links: [{ agentId: "codex", status: "error" as const, detail: "Permission denied" }] },
      ...["release-notes", "code-review", "review-checklist", "lint-rules"].map((name) => ({ name, digest: "d1", links: [{ agentId: "codex", status: "linked" as const }] })),
    ],
    drift: [
      { name: "release-notes", digest: "d1", variant: "agent" as const, observedDigest: "e1".padEnd(64, "0") },
      { name: "deploy-bot", digest: "d1", variant: "agent" as const, observedDigest: "e2".padEnd(64, "0") },
    ],
    unmanaged: [],
    updatedAt: 1_700_000_000_000,
  },
  orphaned: [
    { kind: "deleted_skill" as const, name: "retired-lint", digest: "d0".padEnd(64, "0"), variant: "agent" as const, observedDigest: "e3".padEnd(64, "0") },
    { kind: "deleted_skill" as const, name: "old-triage", digest: "d0".padEnd(64, "0"), variant: "manual" as const, observedDigest: "e4".padEnd(64, "0") },
  ],
};
/**
 * `overview` (#1971): the Library Overview's case, one deployment error, one edited copy, one held
 * Git update and four orphaned copies, with a recommended built-in skill and recent versions and
 * assignment changes. `healthy` is the same library with nothing to review, all assigned, and an
 * offline second machine. Both name their machines and keep Assign and Dismiss in memory.
 */
const SHELL_OVERVIEW = SHELL_SKILLS_MODE === "overview" || SHELL_SKILLS_MODE === "healthy";
const SHELL_OVERVIEW_NOW = Date.now();
const shellAgo = (minutes: number) => SHELL_OVERVIEW_NOW - minutes * 60_000;
const SHELL_OVERVIEW_SKILLS = [
  { name: "deploy-bot", description: "Ships signed builds to the release channel.", groupId: "group-platform", assignmentCount: 1,
    latestVersion: { versionNumber: 4, note: "Sign builds with the release key", createdAt: shellAgo(26 * 60) } },
  { name: "release-notes", description: "Writes release notes from merged pull requests.", groupId: "group-writing", assignmentCount: 1,
    latestVersion: { versionNumber: 2, createdAt: shellAgo(3 * 24 * 60) } },
  { name: "lint-rules", description: "Keeps the team's lint rules current.", groupId: "group-platform", assignmentCount: 1,
    gitSource: SHELL_LIST_GIT_SOURCE,
    ...(SHELL_SKILLS_MODE === "overview"
      ? { gitAutoUpdate: { enabled: true, held: { commit: "9e2a".padEnd(40, "0"), reason: "scripts" as const, scriptPaths: ["scripts/fix.sh"], heldAt: shellAgo(90) } } }
      : { gitAutoUpdate: { enabled: true, held: null } }),
    latestVersion: { versionNumber: 7, note: "Automatic update from Git commit 4c1d000", createdAt: shellAgo(5 * 24 * 60) } },
  { name: "code-review", description: "Reviews a pull request against the team's conventions.", groupId: "group-review", assignmentCount: 2,
    lastAssignmentChangedAt: shellAgo(2 * 60), latestVersion: { versionNumber: 5, createdAt: shellAgo(6 * 24 * 60) } },
  { name: "review-checklist", description: "The checklist a reviewer walks before approving.", groupId: "group-review", assignmentCount: 1,
    latestVersion: { versionNumber: 3, note: "Add migration and test-coverage checks", createdAt: shellAgo(40) } },
  { name: "triage-helper", description: "Labels and routes new issues.", assignmentCount: 1,
    latestVersion: { versionNumber: 1, createdAt: shellAgo(9 * 24 * 60) } },
  { name: "writing-tests", description: "Writes focused tests for a change.", groupId: "group-writing", assignmentCount: 1,
    latestVersion: { versionNumber: 2, createdAt: shellAgo(12 * 24 * 60) } },
  { name: "using-wollipog", description: "Operate Wollipog sessions from inside an agent session.",
    builtIn: { release: "0.29.1", heldUpdate: null }, recommendation: { dismissed: false },
    assignmentCount: SHELL_SKILLS_MODE === "overview" ? 0 : 1, latestVersion: { versionNumber: 1, createdAt: shellAgo(20 * 24 * 60) } },
].map((skill, index) => ({
  id: `skill-${index + 1}`,
  ...skill,
  latestVersion: { id: `v${index + 1}`, digest: `${(index + 1).toString(16).padStart(4, "0")}`.padEnd(64, "a"), ...skill.latestVersion },
}));
const SHELL_OVERVIEW_GROUPS = [
  { id: "group-platform", name: "Platform", sortOrder: 1 },
  { id: "group-review", name: "Review", sortOrder: 2 },
  { id: "group-writing", name: "Writing", sortOrder: 3 },
];
const shellOverviewMachine = () => {
  const healthy = SHELL_SKILLS_MODE === "healthy";
  const names = SHELL_OVERVIEW_SKILLS.filter((skill) => skill.assignmentCount > 0).map((skill) => skill.name);
  return {
    removalReporting: "supported" as const, driftReporting: "supported" as const, keptAsideReporting: "supported" as const,
    desired: names.map(shellListTarget),
    reported: {
      deployed: names.map((name) => ({ name, digest: "d1", links: [{ agentId: "codex",
        ...(name === "deploy-bot" && !healthy ? { status: "error" as const, detail: "Permission denied writing ~/.codex/skills/deploy-bot" } : { status: "linked" as const }) }] })),
      drift: healthy ? [] : [{ name: "release-notes", digest: "d1", variant: "agent" as const, observedDigest: "e1".padEnd(64, "0") }],
      unmanaged: [],
      updatedAt: SHELL_OVERVIEW_NOW,
    },
    orphaned: healthy ? [] : ["retired-lint", "old-triage", "draft-notes", "legacy-review"].map((name, index) => ({
      kind: "deleted_skill" as const, name, digest: "d0".padEnd(64, "0"), variant: "agent" as const, observedDigest: `e${index + 3}`.padEnd(64, "0"),
    })),
  };
};
/** The overview's offline second machine. */
const shellOfflineRunner: RunnerView | null = SHELL_OVERVIEW
  ? { ...structuredClone(runner), runnerId: "runner-2", hostname: "studio-workstation", displayName: "Studio Workstation", status: "offline" }
  : null;
if (SHELL_OVERVIEW) runner.displayName = "Build Machine";
const shellSkills = SHELL_SKILLS_MODE === "empty" ? [] : SHELL_SKILLS_MODE === "list" ? SHELL_LIST_SKILLS : SHELL_OVERVIEW ? SHELL_OVERVIEW_SKILLS : Array.from(
  { length: SHELL_SKILLS_MODE === "many" ? 40 : SHELL_SKILL_NAMES.length },
  (_, index) => ({
    id: `skill-${index + 1}`,
    name: SHELL_SKILL_NAMES[index] ?? `team-skill-${String(index + 1).padStart(2, "0")}`,
    description: index % 3 === 2 ? undefined : `Guides an agent through ${SHELL_SKILL_NAMES[index] ?? "a team task"} the way this team does it.`,
    latestVersion: { id: `v${index + 1}`, digest: `${(index + 1).toString(16).padStart(4, "0")}`.padEnd(64, "a"), createdAt: 1_700_000_000_000 },
    assignmentCount: index === 0 ? 3 : 0,
  }));
const shellSkillMarkdown = (name: string) => [
  "---", `name: ${name}`, "---", "",
  ...Array.from({ length: 24 }, (_, index) => `${index + 1}. Step ${index + 1}: read the change, check it against the team's conventions, and write down what you found before moving on.`),
].join("\n");
/**
 * `?skills=detail` (#1962): the skill detail's header cases. The first skill carries the real
 * orchestrate-issues description (about 450 characters) in a group; the second the longest
 * description the protocol allows, 1,024 characters with line breaks; then a Git skill whose
 * description fits in two lines, a built-in skill, and a machine snapshot. Every version is numbered.
 * `&numbers=0` answers as a control plane from before version numbers.
 */
const SHELL_DETAIL_NUMBERS = FIXTURE_QUERY.get("numbers") !== "0";
const ORCHESTRATE_DESCRIPTION = "Coordinate explicitly requested Wollipog child-session issue campaigns through merge, cleanup, " +
  "recursive follow-ups, and archival. Use only when the user invokes this skill or explicitly asks to orchestrate or " +
  "delegate issue implementation across sessions. A request to claim, implement, or fix multiple issues alone stays in the " +
  "current session and does not trigger this skill. Do not trigger merely because the issues concern Orchestrator features.";
const MAXIMUM_DESCRIPTION = (() => {
  const lines = [
    "Plans a release from the merged pull requests since the last tag.",
    "Groups them by area, flags anything that changes a protocol or a migration, and drafts notes in the team's voice.",
    "",
    "Steps: read the changelog, list the merged pull requests, check each for a migration, a protocol bump or a new setting, " +
      "and write one line per change a user would notice.",
    "Never publish; hand the draft back for review.",
  ];
  let text = lines.join("\n");
  const filler = " Keep each line short, name the change in user terms, and link the pull request.";
  while (text.length < 1024) text += filler.slice(0, 1024 - text.length);
  return text;
})();
const detailVersion = (index: number, number: number) => ({
  id: `skillv_${index}`, digest: `${index.toString(16).padStart(4, "0")}`.padEnd(64, "c"), createdAt: 1_700_000_000_000,
  ...(SHELL_DETAIL_NUMBERS ? { versionNumber: number } : {}),
});
const detailGitSource = { url: "https://github.com/example/skills.git", ref: "main", subdirectory: "skills", path: "skills/code-review", commit: "a".repeat(40) };
const detailSkills = [
  { id: "skill-1", name: "orchestrate-issues", description: ORCHESTRATE_DESCRIPTION, groupId: "group-1",
    latestVersion: detailVersion(1, 3), assignmentCount: 3, updatedAt: Date.now() - 4 * 60_000 },
  { id: "skill-2", name: "release-planner", description: MAXIMUM_DESCRIPTION, latestVersion: detailVersion(2, 7), updatedAt: Date.now() - 2 * 3_600_000 },
  { id: "skill-3", name: "code-review", description: "Reviews a change against the team's conventions before it merges.",
    gitSource: detailGitSource, gitAutoUpdate: { enabled: false }, latestVersion: { ...detailVersion(3, 12), gitSource: detailGitSource },
    updatedAt: Date.now() - 26 * 3_600_000 },
  { id: "skill-4", name: "using-wollipog", description: "Operate Wollipog sessions from inside an agent session.",
    builtIn: { release: "0.29.1", heldUpdate: null }, recommendation: { dismissed: false }, assignmentCount: 1,
    latestVersion: detailVersion(4, 2), updatedAt: Date.now() - 3 * 86_400_000 },
  { id: "skill-5", name: "machine-notes", description: "Notes an agent keeps about this machine: which toolchains are " +
      "installed, where the caches live, and which services must be running before a build starts.",
    latestVersion: { ...detailVersion(5, 1), machineSource: { runnerId: "runner-1", sourceDirectory: ".codex/skills", name: "machine-notes",
      digest: "e".repeat(64), importedAt: 1_700_000_000_000 } }, updatedAt: Date.now() - 9 * 86_400_000 },
];
const detailFiles = (name: string) => [
  { path: "SKILL.md", content: shellSkillMarkdown(name), encoding: "utf8" as const },
  { path: "references/checklist.md", content: "- Read the change.\n", encoding: "utf8" as const },
  { path: "scripts/check.sh", content: "#!/bin/sh\n", encoding: "utf8" as const },
];
/** A second machine, so Deployment and the Orphaned Copies pane show what divides one machine from the next. */
const secondSkillRunner: RunnerView = {
  ...runner, runnerId: "runner-2", hostname: "build-box", displayName: "Build Box", workspaces: [],
};
const detailMode = SHELL_SKILLS_MODE === "detail";
/**
 * `?skills=notices` (#1972): one skill per notice the slot under the header can show. `collect` has a
 * Manual Only rule that Codex and Pi cannot run, and also an edited copy, which takes the slot once
 * the rule is fixed; `lint-rules` an edited Claude Code copy; `fetch-docs` a held Git update;
 * `using-wollipog` a recommended built-in skill whose release update is held; `orchestrate-issues`
 * a recommendation; and `deploy-bot` a machine's own deployment error. Assignments, dismissals and
 * rule changes apply to the fixture, so each notice clears the way it would.
 */
const noticesMode = SHELL_SKILLS_MODE === "notices";
/** `&deployment=1` (#1981): the Studio also has six ACP agents that can't receive managed skills,
 * container and cloud targets, and `deploy-bot`'s error is a long one. */
const deploymentExtras = noticesMode && FIXTURE_QUERY.has("deployment");
const noticeAgent = (id: string, name: string, driver: "claude-code" | "codex" | "pi" | "acp") => ({
  id, name, command: id, args: [], env: {}, driver, context: { kind: "native" as const }, available: true,
});
const noticeTarget = (id: string, name: string, adapter: "host" | "container" | "cloud") => ({
  id, runnerId: "runner-studio", name, kind: adapter === "host" ? "local" as const : adapter, workspaceStrategy: "worktree" as const, adapter,
  boundaries: { filesystem: adapter === "host" ? "worktree" as const : adapter === "cloud" ? "snapshot" as const : "container" as const,
    network: "deny" as const, secrets: "none" as const, billing: "none" as const },
  available: true,
});
const noticeStudio: RunnerView = {
  ...runner, runnerId: "runner-studio", hostname: "studio", displayName: "Studio Workstation", workspaces: [],
  agents: [noticeAgent("claude", "Claude Code", "claude-code"), noticeAgent("codex", "Codex", "codex"), noticeAgent("pi", "Pi", "pi"),
    ...(deploymentExtras ? ["Gemini", "Goose", "Amp", "Cursor", "Aider", "Kiro"].map((name) => noticeAgent(name.toLowerCase(), name, "acp")) : [])],
  ...(deploymentExtras ? { executionTargets: [noticeTarget("studio-host", "Runner Host", "host"),
    noticeTarget("studio-container", "Offline Container", "container"), noticeTarget("studio-cloud", "Cloud Sandbox", "cloud")] } : {}),
};
const noticeLaptop: RunnerView = {
  ...noticeStudio, runnerId: "runner-laptop", hostname: "laptop", displayName: "Travel Laptop", status: "offline",
  agents: noticeStudio.agents.slice(0, 2), executionTargets: undefined,
};
const noticeVersion = (index: number, number: number) => ({
  id: `skillv_n${index}`, digest: `${index.toString(16).padStart(4, "0")}`.padEnd(64, "b"), createdAt: 1_700_000_000_000, versionNumber: number,
});
const noticeGitSource = { url: "https://github.com/example/skills.git", ref: "main", subdirectory: "fetch-docs", path: "fetch-docs", commit: "a1b2".padEnd(40, "0") };
const noticeSkills = [
  { id: "skill-n1", name: "collect", description: "Collects build artifacts and uploads them for review.", latestVersion: noticeVersion(1, 4), assignmentCount: 1 },
  { id: "skill-n2", name: "lint-rules", description: "Keeps the team's lint rules current.", latestVersion: noticeVersion(2, 3), assignmentCount: 1 },
  { id: "skill-n3", name: "fetch-docs", description: "Fetches vendor documentation into the workspace.", gitSource: noticeGitSource,
    gitAutoUpdate: { enabled: true, intervalMs: 3_600_000, checkedAt: 1_700_000_000_000, checkedCommit: "c3d4e5f6a7b8".padEnd(40, "9"),
      held: { commit: "c3d4e5f6a7b8".padEnd(40, "9"), reason: "scripts" as const, scriptPaths: ["scripts/collect.sh", "tool.py"], heldAt: 1_700_000_000_000 } },
    latestVersion: { ...noticeVersion(3, 6), gitSource: noticeGitSource }, assignmentCount: 1 },
  { id: "skill-n4", name: "using-wollipog", description: "Operate Wollipog sessions from inside an agent session.",
    builtIn: { release: "0.29.1", heldUpdate: { release: "0.30.0", digest: "f".repeat(64) } } as { release: string; heldUpdate: { release: string; digest: string } | null },
    recommendation: { dismissed: false }, latestVersion: noticeVersion(4, 2), assignmentCount: 0 },
  { id: "skill-n5", name: "orchestrate-issues", description: ORCHESTRATE_DESCRIPTION, builtIn: { release: "0.29.1", heldUpdate: null },
    recommendation: { dismissed: false }, latestVersion: noticeVersion(5, 1), assignmentCount: 0 },
  { id: "skill-n6", name: "deploy-bot", description: "Ships signed builds.", latestVersion: noticeVersion(6, 9), assignmentCount: 1 },
].map((skill, index) => ({ ...skill, updatedAt: Date.now() - (index + 1) * 3_600_000 }));
type NoticeRule = { id: string; skillId: string; scopeKind: "instance" | "runner"; runnerId?: string; agentSelector: { kind: string; driver?: string };
  enabled: boolean; invocation: "agent" | "manual"; updatedAt: number };
const noticeRules: NoticeRule[] = [
  { id: "rule-collect", skillId: "skill-n1", scopeKind: "instance", agentSelector: { kind: "all" }, enabled: true, invocation: "manual", updatedAt: 1 },
  { id: "rule-lint", skillId: "skill-n2", scopeKind: "instance", agentSelector: { kind: "driver", driver: "claude-code" }, enabled: true, invocation: "manual", updatedAt: 1 },
  { id: "rule-fetch", skillId: "skill-n3", scopeKind: "instance", agentSelector: { kind: "all" }, enabled: true, invocation: "agent", updatedAt: 1 },
  { id: "rule-deploy", skillId: "skill-n6", scopeKind: "runner", runnerId: "runner-studio", agentSelector: { kind: "driver", driver: "codex" }, enabled: true, invocation: "agent", updatedAt: 1 },
];
/** What a machine is told to deploy, from the fixture's rules, as the control plane resolves them. */
const noticeDesired = (machine: RunnerView) => noticeSkills.flatMap((skill) => {
  const rules = noticeRules.filter((rule) => rule.skillId === skill.id && (rule.scopeKind === "instance" || rule.runnerId === machine.runnerId));
  // The control plane targets only agents that can receive managed skills.
  const targets = machine.agents.filter((agent) => agent.driver !== "acp").flatMap((agent) => {
    const winner = rules.filter((rule) => rule.agentSelector.kind === "all" || rule.agentSelector.driver === agent.driver)
      .sort((a, b) => Number(b.scopeKind === "runner") - Number(a.scopeKind === "runner") ||
        Number(b.agentSelector.kind !== "all") - Number(a.agentSelector.kind !== "all"))[0];
    return winner?.enabled ? [{ agentId: agent.id, invocation: winner.invocation }] : [];
  });
  return targets.length ? [{ name: skill.name, versionDigest: skill.latestVersion.digest, targets }] : [];
});
const noticeMachine = (runnerId: string) => {
  const machine = runnerId === noticeStudio.runnerId ? noticeStudio : noticeLaptop;
  const desired = noticeDesired(machine);
  const studio = machine === noticeStudio;
  return structuredClone({
    removalReporting: "supported" as const, driftReporting: "supported" as const, keptAsideReporting: "supported" as const,
    desired,
    reported: {
      deployed: desired.map((entry) => ({ name: entry.name, digest: entry.versionDigest, links: entry.targets.map((target) =>
        studio && entry.name === "deploy-bot"
          ? { agentId: target.agentId, status: "error" as const, detail: deploymentExtras
            ? "Permission denied: ~/.codex/skills/deploy-bot is owned by root, so the runner could not replace the link with the library's version. Change the folder's owner or remove it, then sync again."
            : "Permission denied: ~/.codex/skills/deploy-bot is owned by root." }
          // As the runner reports it: only Claude Code can enforce manual-only invocation.
          : target.invocation === "manual" && target.agentId !== "claude"
            ? { agentId: target.agentId, status: "unsupported" as const, detail: "Manual-only invocation is not supported for this agent." }
            : { agentId: target.agentId, status: "linked" as const }) })),
      drift: studio ? [
        { name: "lint-rules", digest: noticeSkills[1]!.latestVersion.digest, variant: "manual" as const, observedDigest: "e2".padEnd(64, "0"), held: true },
        { name: "collect", digest: noticeSkills[0]!.latestVersion.digest, variant: "manual" as const, observedDigest: "e1".padEnd(64, "0"), held: true },
      ] : [],
      unmanaged: [],
      updatedAt: Date.now() - 5 * 60_000,
    },
  });
};
const noticesApi = {
  listSkills: async () => ({ skills: structuredClone(noticeSkills) }),
  listSkillGroups: async () => ({ groups: [] }),
  getSkill: async (id: string) => {
    const skill = noticeSkills.find((candidate) => candidate.id === id);
    if (!skill) throw new Error("HTTP 404: skill not found");
    return { skill: structuredClone(skill), latestVersion: { ...structuredClone(skill.latestVersion), files: detailFiles(skill.name) } };
  },
  getMachineSkillVersionPolicy: async () => ({ policy: null }),
  listSkillAssignments: async (skillId?: string) => ({ assignments: structuredClone(noticeRules.filter((rule) => rule.skillId === skillId)) }),
  runnerSkills: async (runnerId: string) => noticeMachine(runnerId),
  syncRunnerSkills: async (runnerId: string) => noticeMachine(runnerId).reported,
  createSkillAssignment: async (body: Omit<NoticeRule, "id" | "enabled" | "updatedAt">) => {
    const rule: NoticeRule = { ...body, id: `rule-${noticeRules.length + 1}`, enabled: true, updatedAt: Date.now() };
    noticeRules.push(rule);
    const skill = noticeSkills.find((candidate) => candidate.id === body.skillId)!;
    skill.assignmentCount += 1;
    return { assignment: structuredClone(rule) };
  },
  updateSkillAssignment: async (id: string, body: Partial<Pick<NoticeRule, "enabled" | "invocation" | "agentSelector">>) => {
    const rule = noticeRules.find((candidate) => candidate.id === id)!;
    Object.assign(rule, body, { updatedAt: Date.now() });
    return { assignment: structuredClone(rule) };
  },
  setSkillRecommendationDismissed: async (id: string, dismissed: boolean) => {
    const skill = noticeSkills.find((candidate) => candidate.id === id)!;
    skill.recommendation = { dismissed };
    return { skill: structuredClone(skill) };
  },
};
const shellSkillsApi = {
  listSkills: async () => {
    if (SHELL_SKILLS_MODE === "loading") return new Promise<never>(() => {});
    if (SHELL_SKILLS_MODE === "error") throw new Error("HTTP 503: skill library unavailable (GET /api/skills)");
    return { skills: structuredClone(detailMode ? detailSkills : shellSkills) };
  },
  listSkillGroups: async () => ({ groups: detailMode ? [{ id: "group-1", name: "Campaigns", sortOrder: 0 }]
    : SHELL_SKILLS_MODE === "list" ? [{ id: "group-platform", name: "Platform", sortOrder: 1 }]
    : SHELL_OVERVIEW ? SHELL_OVERVIEW_GROUPS : [] }),
  getSkill: async (id: string) => {
    if (detailMode) {
      const skill = detailSkills.find((candidate) => candidate.id === id);
      if (!skill) throw new Error("HTTP 404: skill not found");
      return { skill: structuredClone(skill), latestVersion: { ...structuredClone(skill.latestVersion), files: detailFiles(skill.name) } };
    }
    const skill = shellSkills.find((candidate) => candidate.id === id);
    if (!skill) throw new Error("HTTP 404: skill not found");
    return {
      skill: structuredClone(skill),
      latestVersion: { ...skill.latestVersion, files: [{ path: "SKILL.md", content: shellSkillMarkdown(skill.name), encoding: "utf8" as const }] },
    };
  },
  ...(detailMode ? {
    getMachineSkillVersionPolicy: async () => ({ policy: null }),
    listSkillGroupAssignments: async () => ({ assignments: [] }),
  } : {}),
  listSkillAssignments: async (skillId?: string) => ({ assignments: skillId !== "skill-1" ? [] : [
    { id: "assignment-1", skillId, scopeKind: "instance" as const, agentSelector: { kind: "all" as const }, enabled: true, invocation: "agent" as const },
    { id: "assignment-2", skillId, scopeKind: "runner" as const, runnerId: "runner-1",
      agentSelector: { kind: "driver" as const, driver: "claude-code" }, enabled: true, invocation: "manual" as const },
    { id: "assignment-3", skillId, scopeKind: "runner" as const, runnerId: "runner-1",
      agentSelector: { kind: "all" as const }, enabled: false, invocation: "agent" as const },
  ] }),
  runnerSkills: async (runnerId?: string) => SHELL_SKILLS_MODE === "list"
    ? structuredClone(SHELL_LIST_MACHINE)
    : SHELL_OVERVIEW && runnerId === "runner-1"
      ? shellOverviewMachine()
      : { desired: [], reported: null, removalReporting: "unknown" as const },
  ...(SHELL_OVERVIEW ? {
    createSkillAssignment: async (body: { skillId: string }) => {
      const skill = SHELL_OVERVIEW_SKILLS.find((candidate) => candidate.id === body.skillId)!;
      skill.assignmentCount += 1;
      Object.assign(skill, { lastAssignmentChangedAt: Date.now() });
      return { assignment: { id: `assignment-${skill.id}-${skill.assignmentCount}`, enabled: true, ...body } };
    },
    setSkillRecommendationDismissed: async (skillId: string, dismissed: boolean) => {
      const skill = SHELL_OVERVIEW_SKILLS.find((candidate) => candidate.id === skillId)!;
      Object.assign(skill, { recommendation: { dismissed } });
      return { skill: structuredClone(skill) };
    },
  } : {}),
};

const client = {
  ...api,
  ...shellSkillsApi,
  ...(noticesMode ? noticesApi : {}),
  // One page of the fixture's sessions as the Archived Sessions table lists them. The Archived
  // filter shows every session as archived, so the table has rows to lay out.
  archiveSessionPage: async (input: Parameters<typeof api.archiveSessionPage>[0]) => {
    const sessions = model.sessions
      .map((value) => (input.archive === "archived" ? { ...value, archived: true } : value))
      .filter((value) => input.archive === "all" || value.archived === (input.archive === "archived"));
    const projectName = (id: string | null | undefined) => model.projects.find((candidate) => candidate.id === id)?.name ?? "No Project";
    return structuredClone({
      sessions,
      snippets: {},
      metadata: Object.fromEntries(sessions.map((value) => [value.id, {
        project: projectName(value.projectId), location: value.workspaceName ?? "", agent: value.agentName ?? value.agentId,
      }])),
      nextCursor: null,
      hasMore: false,
      facets: {
        projects: [...new Set(sessions.map((value) => projectName(value.projectId)))],
        locations: [...new Set(sessions.map((value) => value.workspaceName ?? ""))],
        agents: [...new Set(sessions.map((value) => value.agentName ?? value.agentId))],
      },
    });
  },
  sessionUsage: async (sessionId: string) => {
    const value = model.sessions.find((candidate) => candidate.id === sessionId)!;
    const totals = {
      inputTokens: value.tokensIn, outputTokens: value.tokensOut, costUsd: value.costUsd,
      uncachedInputTokens: value.tokensIn, cachedInputTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
      processedTokens: value.tokensIn + value.tokensOut, cacheSavingsUsd: 0,
      costSource: "providerReported" as const, unpricedRecords: 0,
    };
    return { sessionId, totals, byModel: [] };
  },
  descendantRequests: async (_sessionId: string, signal?: AbortSignal) => {
    descendantRequestCallCount += 1;
    if (failNextDescendantRequest) {
      failNextDescendantRequest = false;
      throw new Error("Descendant request fixture unavailable");
    }
    if (deferNextDescendantRequest) {
      deferNextDescendantRequest = false;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          pendingDescendantRequestSettlement = null;
          reject(new DOMException("Aborted", "AbortError"));
        };
        pendingDescendantRequestSettlement = () => {
          signal?.removeEventListener("abort", abort);
          pendingDescendantRequestSettlement = null;
          resolve();
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return { requests: structuredClone(descendantRequestRows) };
  },
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
    teams: structuredClone(identityTeams),
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
  projectLocationWorktreeSetup: async (_projectId: string, locationId: string) => ({
    locationId,
    status: { status: "valid" as const, hash: "a".repeat(64) },
  }),
  agentHarnessDefaults: async () => ({ defaults: FIXTURE_QUERY.get("orchestratorDefault") === "1" ? [{
    agentId: "codex", driver: "codex-app-server" as const, context: { kind: "native" as const },
    name: "Codex", installations: [], compatibleInstallations: 1,
    preference: { permissionMode: "orchestrator" },
  }] : [] }),
  orchestratorSettings: async () => ({
    defaults: structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS),
    source: "user_default" as const,
    capabilities: {
      harnesses: [{
        agentId: "codex",
        driver: "codex-app-server" as const,
        context: { kind: "native" as const },
        name: "Codex",
        models: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", efforts: ["low", "high"] }],
        effortLevels: ["low", "high"],
        supportedPairs: [{ modelId: "gpt-5.6-sol", effortLevels: ["low", "high"] }],
        installations: 1,
      }],
      models: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", efforts: ["low", "high"] }],
      effortLevels: ["low", "high"],
      installations: 1,
      compatibleInstallations: 1,
      status: "available" as const,
    },
  }),
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
  // #1780: the runner ends only this job; a Result Blocked sibling's result is then delivered.
  stopBackgroundJob: async (id: string, jobId: string) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    const job = value.backgroundJobs?.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error("background job not found");
    if (job.terminalStatus) {
      return { sessionId: id, jobId, outcome: "already_terminal" as const, terminalStatus: job.terminalStatus };
    }
    const now = Date.now();
    Object.assign(job, {
      terminalStatus: "killed", terminalObservedAt: now, continuationRequired: false, lastObservedAt: now,
      // #1849: the runner reports who asked, naming the person by role only.
      endedBy: { actor: { kind: "user" }, reason: "stop_request", endedAt: now },
    });
    for (const sibling of value.backgroundJobs ?? []) {
      if (sibling.parentTurnId === job.parentTurnId && sibling.terminalStatus && sibling.continuationRequired) {
        sibling.assistantResultPersistedAt = now;
      }
    }
    for (const delivery of value.backgroundDeliveries ?? []) {
      if (delivery.parentTurnId !== job.parentTurnId || delivery.watchdogState !== "continuation_blocked") continue;
      delete delivery.watchdogState;
      delete delivery.unfinishedSiblingJobs;
      delivery.terminalCount = delivery.jobCount;
      delivery.runnerResultPersistedAt = now;
    }
    if (!(value.backgroundJobs ?? []).some((candidate) => !candidate.terminalStatus)) value.backgroundWorkState = undefined;
    value.updatedAt += 1;
    pushSession(value);
    return { sessionId: id, jobId, outcome: "stopped" as const, terminalStatus: "killed" as const };
  },
  acknowledgeBackgroundMissingResult: async (id: string, continuationId: string) => {
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    const delivery = value.backgroundDeliveries?.find((candidate) =>
      candidate.continuationId === continuationId);
    if (!delivery?.missingResultAt) throw new Error("background delivery is not terminally missing");
    delivery.missingResultAcknowledgedAt = Date.now();
    delete delivery.watchdogState;
    value.updatedAt += 1;
    pushSession(value);
    return structuredClone(value);
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
  handoff: async (id: string, turn: number, agentId: string, config: SessionConfig) => {
    handoffRequests.push({ id, turn, agentId, config: structuredClone(config) });
    const source = model.sessions.find((candidate) => candidate.id === id)!;
    const agent = runner.agents.find((candidate) => candidate.id === agentId)!;
    const handoffDraft = buildConversationHandoff(sessionEvents.get(id) ?? [], 3, agent, config);
    const child = { ...source, id: "handoff-child", agentId, driver: agent.driver!, title: "Checkpoint Handoff", ...config, status: "idle" as const };
    model.sessions.push(child);
    sessionEvents.set(child.id, [{ id: 1, sessionId: child.id, seq: 1, ts: 4, payload: { kind: "conversation_forked", sourceSessionId: id, turn,
      handoff: { sourceAgent: source.agentId!, destinationAgent: agentId, disclosure: handoffDraft.disclosure } } }]);
    pushSession(child);
    return { ...structuredClone(child), handoffDraft };
  },
  recoverQuarantinedConversation: async (
    id: string,
    turn: number,
    handoff?: { agentId: string; config: SessionConfig },
  ) => {
    recoveryRequests.push({ id, turn, handoff });
    const source = model.sessions.find((candidate) => candidate.id === id)!;
    const child = { ...source, id: "recovered-child", title: "Recovered Session", status: "idle" as const };
    delete (child as { historyQuarantine?: unknown }).historyQuarantine;
    model.sessions.push(child);
    sessionEvents.set(child.id, [{ id: 1, sessionId: child.id, seq: 1, ts: 7,
      payload: { kind: "conversation_forked", sourceSessionId: id, turn } }]);
    pushSession(child);
    if (!handoff) return { ...structuredClone(child), retainedPrompt: { text: "Now scan every changed file.", images: [] } };
    const agent = runner.agents.find((candidate) => candidate.id === handoff.agentId)!;
    const handoffDraft = buildConversationHandoff(sessionEvents.get(id) ?? [], 3, agent, handoff.config);
    return { ...structuredClone(child), handoffDraft };
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
    if (action === "dismiss" && attempt.resolution?.action === "queue_again" &&
        attempt.resolution.state === "applied") {
      value.steeringAttempts = value.steeringAttempts?.filter(
        (candidate) => candidate.submissionId !== submissionId,
      );
      pushSession(value);
      return structuredClone(attempt);
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
  updateProject: async (id: string, patch: import("@wollipog/protocol").UpdateProjectRequest) => {
    if (nextProjectUpdateError) {
      const message = nextProjectUpdateError;
      nextProjectUpdateError = null;
      throw new Error(message);
    }
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
  searchWorkspaceReferences: async (_sessionId: string, query: string) => ({
    results: [{ path: "src/session.ts", isDirectory: false }].filter((candidate) => candidate.path.includes(query)),
    truncated: false,
  }),
  createWorkspaceReference: async (_sessionId: string, target: CreateWorkspaceReferenceRequest) => {
    const reference: WorkspaceReference = {
      artifactId: `workspace:${target.path}`,
      mimeType: "application/vnd.wollipog.workspace-reference+json",
      sizeBytes: 0,
      sha256: "a".repeat(64),
      referenceVersion: 1,
      kind: target.kind,
      path: target.path,
      rootFingerprint: "b".repeat(64),
      targetFingerprint: "a".repeat(64),
    };
    return { reference };
  },
  // Legacy workspace re-filing (#2163): control planes without projects.
  setWorkspace: async (id: string, workspaceId: string | null) => {
    workspaceMoveCount += 1;
    const value = model.sessions.find((candidate) => candidate.id === id);
    if (!value) throw new Error("session not found");
    const workspace = workspaceId ? runner.workspaces.find((candidate) => candidate.id === workspaceId) : undefined;
    if (workspaceId && !workspace) throw new Error("workspace not found");
    value.workspaceId = workspaceId;
    value.workspaceName = workspace?.name ?? null;
    value.updatedAt += 1;
    saveModel();
    window.setTimeout(() => socket?.push({ type: "session_upsert", session: structuredClone(value) }), 0);
    return structuredClone(value);
  },
  createWorkspace: async (_runnerId: string, body: { name: string; path: string }) => {
    const workspace = { id: `created-workspace-${runner.workspaces.length + 1}`, name: body.name, path: body.path };
    runner.workspaces.push(workspace);
    window.setTimeout(() => socket?.push({ type: "runner_upsert", runner: structuredClone(runner) }), 0);
    return { workspace: structuredClone(workspace) };
  },
  listDirectory: async (_runnerId: string, path: string) => {
    const at = path || "/repos";
    const parent = at === "/" ? null : at.slice(0, at.lastIndexOf("/")) || "/";
    const entries = at === "/repos"
      ? ["alpha", "billing-service", "loose"].map((name) => ({ name, path: `/repos/${name}`, isDir: true }))
      : [];
    return { path: at, parent, entries };
  },
} as ApiClient;

let workspaceMoveCount = 0;
let identityTeams: TeamView[] = [];

let nextProjectUpdateError: string | null = null;

declare global {
  interface Window {
    /** Raises toasts through the real provider, for the placement and stacking specs. */
    __WOLLIPOG_TOASTS_E2E__?: { show(message: string, options?: Omit<ToastOptions, "action"> & { actionLabel?: string }): number };
    __WOLLIPOG_PROJECT_INBOX_E2E__: {
      failNextProjectUpdate(message?: string): void;
      updateProject(id: string, patch: Partial<Pick<ProjectView, "name" | "hidden" | "childSessionDefaults">>): void;
      updateSession(
        id: string,
        patch: Partial<Pick<SessionView,
          "projectId" | "projectName" | "projectLocationId" | "audience" | "status" | "queued" | "queueHeld" |
          "pendingApproval" | "activeTurnId" | "adopted" | "importLocationReady" | "agentCapabilities" |
          "steeringAttempts" | "preview" | "lastEventAt" | "title" | "titleSource" | "maxChildSessions">>,
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
      recoveryRequests(): Array<{ id: string; turn: number; handoff?: { agentId: string; config: SessionConfig } }>;
      handoffRequests(): Array<{ id: string; turn: number; agentId: string; config: SessionConfig }>;
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
      setOrchestratorAgentFixture(options: {
        context: "native" | "wsl";
        permissionModes: string[];
        requirement?: string;
        /** Present the fixture agent as this harness; Codex app-server when omitted. */
        driver?: "claude-code" | "codex-app-server" | "pi";
        /** Publish the runner-attested additive role flag (`capabilities.orchestratorAdditive`). */
        orchestratorAdditive?: boolean;
        /** Advertise the v160 control-plane capability for an independent Session Role. */
        controlPlaneRole?: boolean;
        /** Host platform of the fixture runner. Codex's audited sandbox exists on Linux and macOS
         * only, and that is the coupled preset's precondition rather than the additive role's. */
        os?: RunnerView["os"];
      }): void;
      pushSnapshot(): void;
      deferNextGit(id: string, action: GitFixtureAction): void;
      settleDeferredGit(id: string, action: GitFixtureAction): void;
      failNextGit(id: string, action: GitFixtureAction, message?: string): void;
      setGitUnavailable(id: string, unavailable: boolean): void;
      setGitSummary(id: string, patch: Partial<GitSummaryInfo>): void;
      setGitStatus(id: string, patch: Partial<GitStatusInfo>): void;
      gitRequestCounts(id: string): { status: number; summary: number };
      setSlashCommands(
        commands: AgentSlashCommand[],
        permissionModes?: string[],
        options?: {
          supportsImages?: boolean;
          attachmentPolicy?: ProviderComposerCommand["attachmentPolicy"];
          models?: AgentCapabilities["models"];
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
      setDescendantRequests(state: "one" | "empty"): void;
      deferNextDescendantRequests(): void;
      settleDeferredDescendantRequests(): void;
      failNextDescendantRequests(): void;
      descendantRequestCallCount(): number;
      workspaceMoveCount(): number;
      setIdentityTeams(teams: TeamView[]): void;
    };
  }
}

window.__WOLLIPOG_PROJECT_INBOX_E2E__ = {
  workspaceMoveCount: () => workspaceMoveCount,
  setIdentityTeams(teams) {
    identityTeams = structuredClone(teams);
  },
  setDescendantRequests(state) {
    descendantRequestRows = state === "one" ? [descendantRequestFixture()] : [];
  },
  deferNextDescendantRequests() {
    deferNextDescendantRequest = true;
  },
  settleDeferredDescendantRequests() {
    if (!pendingDescendantRequestSettlement) throw new Error("no deferred descendant request");
    pendingDescendantRequestSettlement();
  },
  failNextDescendantRequests() {
    failNextDescendantRequest = true;
  },
  descendantRequestCallCount: () => descendantRequestCallCount,
  failNextProjectUpdate(message = "Could not save Project settings. Please retry.") { nextProjectUpdateError = message; },
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
  recoveryRequests: () => structuredClone(recoveryRequests),
  handoffRequests: () => structuredClone(handoffRequests),
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
  setOrchestratorAgentFixture(options) {
    const agent = runner.agents[0]!;
    const capabilities = agent.capabilities;
    runner.os = options.os ?? "linux";
    agent.context = options.context === "wsl"
      ? { kind: "wsl", distro: "Ubuntu-24.04" }
      : { kind: "native" };
    agent.capabilities = {
      ...capabilities,
      models: capabilities?.models ?? [],
      effortLevels: capabilities?.effortLevels ?? [],
      slashCommands: capabilities?.slashCommands ?? [],
      supportsImages: capabilities?.supportsImages ?? false,
      supportsApprovals: capabilities?.supportsApprovals ?? true,
      permissionModes: [...options.permissionModes],
      ...(options.orchestratorAdditive ? { orchestratorAdditive: true } : {}),
    };
    if (options.driver === "pi") {
      agent.driver = "pi";
      agent.name = "Pi";
      agent.codexAppServer = undefined;
    } else if (options.driver === "claude-code") {
      agent.driver = "claude-code";
      agent.name = "Claude Code";
      agent.codexAppServer = undefined;
    } else {
      agent.codexAppServer = {
        status: "supported",
        appServerAvailable: true,
        orchestratorApproval: options.requirement
          ? { status: "unsupported", failure: options.requirement }
          : { status: "supported" },
      };
    }
    orchestratorRoleSupported = options.controlPlaneRole === true;
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
  setGitSummary(id, patch) {
    const fixture = gitFixtures.get(id);
    if (!fixture) throw new Error(`unknown Git fixture: ${id}`);
    Object.assign(fixture.summary, structuredClone(patch));
  },
  setGitStatus(id, patch) {
    const fixture = gitFixtures.get(id);
    if (!fixture) throw new Error(`unknown Git fixture: ${id}`);
    Object.assign(fixture.status, structuredClone(patch));
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
      models: options.models ?? capabilities?.models ?? [],
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
    const resumed = value.queued?.[0];
    value.messageCount = seq;
    value.status = "idle";
    value.queueHeld = false;
    value.activeTurnId = undefined;
    value.updatedAt += 1;
    value.lastEventAt = value.updatedAt;
    saveModel();
    socket?.push({
      type: "session_event",
      event: { id: seq, sessionId: id, seq, ts: value.updatedAt, payload: { kind: "turn_interrupted" } },
    });
    socket?.push({ type: "session_upsert", session: structuredClone(value) });
    if (resumed) {
      setTimeout(() => {
        value.queued?.shift();
        value.status = "running";
        value.activeTurnId = resumed.id;
        value.updatedAt += 1;
        value.lastEventAt = value.updatedAt;
        saveModel();
        socket?.push({ type: "session_upsert", session: structuredClone(value) });
      }, 0);
    }
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
      sessionActions={(
        <>
          {/* Production's glyphs and small size, so the phone top bar's icon rule has an icon to size
              (#2081) and each toggle borrows its 44px touch target (#2146). */}
          <button type="button" className="icon-btn sm" aria-label="Toggle Pinned Summary"><PinnedPanelIcon size={16} /></button>
          <button type="button" className="icon-btn sm" aria-label="Show Terminal"><DockBottomIcon size={16} /></button>
          <button type="button" className="icon-btn sm" aria-label="Show Side Panel"><PanelRightIcon size={16} /></button>
        </>
      )}
      sessionTitle={sessionDisplayTitle(sessions.get(view.id)?.title ?? "") || "Session"}
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
      SCENARIO !== "preview-follow" && SCENARIO !== "preview-opening-fill" &&
      SCENARIO !== "permission-mode-layout") {
    return (
      <>
        {mobileSessionShell}
        <SessionDetail
          sessionId={view.id}
          mode="expanded"
          rightPanel={rightPanel}
          onOpenTerminal={openTerminal}
          pinnedSummary={staticPinnedSummary(STATIC_SUMMARY_OPEN)}
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
        pinnedSummary={staticPinnedSummary(STATIC_SUMMARY_OPEN)}
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

function ToastHook() {
  const feedback = useFeedback();
  useEffect(() => {
    window.__WOLLIPOG_TOASTS_E2E__ = {
      show: (message, { actionLabel, ...options } = {}) => feedback.showToast(message, {
        ...options,
        ...(actionLabel ? { action: { label: actionLabel, run: () => undefined } } : {}),
      }),
    };
  }, [feedback]);
  return null;
}

/**
 * `?fullShell=1&desktopApp=mac` renders the real Shell as the macOS desktop app lays it out (#1979):
 * the instance tile in the rail, and the strip its traffic lights sit in. A browser cannot draw the
 * native window, so this is the web content's side of it.
 */
const MAC_DESKTOP_APP = FIXTURE_QUERY.get("fullShell") === "1" && FIXTURE_QUERY.get("desktopApp") === "mac";
if (MAC_DESKTOP_APP) document.documentElement.classList.add("macos-title-bar");
const fullShell = MAC_DESKTOP_APP
  ? <InstancesContextProvider value={{ ...browserInstanceManager, desktopMultiInstance: true }}><Shell /></InstancesContextProvider>
  : <Shell />;

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <InstanceScopeProvider instanceScope="project-inbox-e2e">
      <ApiProvider client={client}>
        <FeedbackProvider>
          <ToastHook />
          <StoreProvider connection={connection} navigation={navigation}>
            {FIXTURE_QUERY.get("fullShell") === "1" ? <ThemeProvider>{fullShell}</ThemeProvider> : SCENARIO === "permission-mode-layout" ? (
              <div className="app">
                <main className="main">
                  <div className="main-body inbox-main-body">
                    <FixtureSurface />
                  </div>
                </main>
              </div>
            ) : <FixtureSurface />}
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>
    </InstanceScopeProvider>
  </React.StrictMode>,
);
