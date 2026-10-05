import { useMemo, useRef, useState, type MutableRefObject } from "react";
import { createRoot } from "react-dom/client";
import {
  pendingRequests,
  prioritizedPendingRequests,
  removePendingRequest,
  sessionHolds,
  type DescendantRequestView,
  type PendingApproval,
  type SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { CampaignContinuationNotice } from "../components/SessionDetail.js";
import { CampaignHeldChildren } from "../components/CampaignHeldChildren.js";
import { RightPanel, type RightPanelState } from "../components/RightPanel.js";
import { Notice } from "../components/Notice.js";
import {
  SESSION_NOTICE_RANK,
  SessionNoticeSlot,
  type SessionNoticeEntry,
  type SessionNoticeLead,
} from "../components/SessionNoticeSlot.js";
import { RequestDock, dockRequests } from "../components/requests/RequestDock.js";
import { RequestKindIcon, pendingRequestsTitle } from "../components/requests/request-meta.js";
import type { RequestIntentHandler } from "../components/requests/RequestCard.js";
import { useSessionReadingKeys } from "../useSessionReadingKeys.js";
import { SessionApprovalRegion, focusSessionRequest } from "../components/SessionApproval.js";
import { EventTimeline } from "../components/EventTimeline.js";
import {
  sessionRequestPanelKey,
  type DescendantRequestStatus,
} from "../components/SessionRequestPanel.js";
import { SessionStatusIndicators } from "../components/common.js";
import type { RightPanelMode } from "../right-panel.js";
import type { TimelineItem } from "../timeline.js";
import "../styles.css";

declare global {
  interface Window {
    __WOLLIPOG_REQUEST_SURFACES_E2E__: {
      openedChild(): DescendantRequestView | null;
      submissions(): unknown[];
      artifactRequests(): string[];
      openedHeldChild(): string | null;
      clearHold(sessionId: string): void;
      /** The next decision fails, as a runner that refuses it would. */
      failNextDecision(): void;
      /** What the status control and the working line's Review do: bring a request into view. */
      reveal(requestId: string): boolean;
    };
  }
}

const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "evidence";
// The request dock's states (#2179): `runner=offline`, `respond=viewer` (a Viewer's refusal),
// `notices=1` (two session notices behind the card's "+N More"), `tall=1` (a body taller than the
// dock's cap) and `keyboard=1` (the software keyboard is open).
const query = new URLSearchParams(window.location.search);
const runnerOnline = query.get("runner") !== "offline";
const respondAs = query.get("respond");
const withNotices = query.get("notices") === "1";
const tallBody = query.get("tall") === "1";
const keyboardOpen = query.get("keyboard") === "1";
let failNextDecision = false;
const evidenceCount = Number(new URLSearchParams(window.location.search).get("items")) || 8;
// `bounded=1` replaces the held children with one whose handoff the runner bounds (#1778);
// `bounded=legacy` shows the same hold as a runner without the bound reports it.
const boundedParam = new URLSearchParams(window.location.search).get("bounded");
const boundedHold = boundedParam === "1" || boundedParam === "legacy";
// `restart=keeps` reports that hold as a v191 runner does, whose restart keeps the queue (#1779).
const restartKeepsQueue = new URLSearchParams(window.location.search).get("restart") === "keeps";
// `reader=viewer` writes the held children's advice as the control plane writes it for a Viewer, who
// may take none of its actions (#1867, #1875); `reader=admin`, for an admin who does not own them
// and so may restart them but not stop their jobs (#1875).
const readerParam = new URLSearchParams(window.location.search).get("reader");
const heldChildReader = readerParam === "viewer"
  ? { canStopJobs: false, canRestart: false, canManageWorktrees: false }
  : readerParam === "admin"
  ? { canStopJobs: false, canRestart: true, canManageWorktrees: true }
  : undefined;
// `stoppable=1` reports the bounded hold as a v190 runner does, which can stop one of its jobs (#1780).
const stoppableJobs = new URLSearchParams(window.location.search).get("stoppable") === "1";
// `continuation=<state>` picks the continuation the `continuation` scenario shows: `missing_result`
// (the default), `failed` (automatic retries stopped), `failed-auto` (Wollipog retries it), `pending`,
// `running` or `held`. `busy=1` shows its action running and `refusal=1` refuses it to the reader.
// `scenario=gallery` stacks every state; `scenario=both` shows a failed continuation over Held Children.
const continuationParam = new URLSearchParams(window.location.search).get("continuation") ?? "missing_result";
const continuationBusy = new URLSearchParams(window.location.search).get("busy") === "1";
const continuationRefusal = new URLSearchParams(window.location.search).get("refusal") === "1"
  ? "Your Viewer role is read-only." : null;
const includeDescendants = scenario === "descendants" || scenario === "held" ||
  new URLSearchParams(window.location.search).get("children") === "1";
const requestedPollStatus = new URLSearchParams(window.location.search).get("pollStatus");
const descendantRequestStatus: DescendantRequestStatus = requestedPollStatus === "loading" ||
  requestedPollStatus === "unavailable" ? requestedPollStatus : "ready";
// `artifacts` makes the evidence artifact-backed: `ready` (every item), `mixed` (artifact, URI-only,
// and video items together), `unrenderable` (a PNG artifact, a URI-only item, and two artifacts the card
// cannot draw, one SVG and one with no media type, both carrying an external copy), `mismatch` (item 2's bytes do not match its digest), `unavailable`
// (item 2 is gone), or `undecodable` (item 2 has a PNG signature, a correct digest, and a body no
// browser can draw, which is exactly what the artifact validator's signature check admits). The captures are drawn here so the fixture needs no binary files.
const artifactMode = new URLSearchParams(window.location.search).get("artifacts");
const artifactBytes = new Map<string, ArrayBuffer>();
const artifactDigests = new Map<string, string>();
const artifactRequests: string[] = [];

async function drawCapture(index: number): Promise<ArrayBuffer> {
  const wide = index % 2 === 0;
  const canvas = document.createElement("canvas");
  canvas.width = wide ? 960 : 390;
  canvas.height = wide ? 600 : 760;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#0f1720";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#1c2b3a";
  context.fillRect(0, 0, canvas.width, 56);
  context.fillStyle = ["#2f8f83", "#c9772e", "#5b7fd6", "#a65bb5"][index % 4]!;
  context.fillRect(24, 88, canvas.width - 48, 140);
  context.fillStyle = "#223446";
  for (let row = 0; row < 5; row += 1) context.fillRect(24, 260 + row * 56, canvas.width - 48 - row * 40, 36);
  context.fillStyle = "#e6edf3";
  context.font = "600 22px system-ui, sans-serif";
  context.fillText(`Capture ${index + 1} — ${wide ? "Desktop" : "Mobile"} After`, 24, 36);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
  return blob.arrayBuffer();
}

// A page opened over plain HTTP at a network address has no SubtleCrypto. The card refuses such
// evidence before hashing it, so the recorded digest is never compared there; a placeholder keeps
// the fixture loadable, and a card that did show the bytes would read them as a mismatch.
async function fixtureDigest(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return "e".repeat(64);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function prepareArtifacts(): Promise<void> {
  if (!artifactMode) return;
  if (artifactMode === "video" || artifactMode === "mixed") {
    const bytes = await fetch(new URL("../../e2e/fixtures/session-artifact-review.webm", import.meta.url)).then((response) => response.arrayBuffer());
    artifactBytes.set("art_clip", bytes);
    artifactDigests.set("art_clip", await fixtureDigest(bytes));
  }
  for (let index = 0; index < evidenceCount; index += 1) {
    const bytes = artifactMode === "undecodable" && index === 1
      ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("not an image")]).buffer
      : await drawCapture(index);
    artifactBytes.set(`art_${index + 1}`, bytes);
    artifactDigests.set(`art_${index + 1}`, await fixtureDigest(bytes));
  }
}

let openedChild: DescendantRequestView | null = null;
let openedHeldChild: string | null = null;
let clearHold: (sessionId: string) => void = () => {};
const submissions: unknown[] = [];

function evidenceSession(): SessionView {
  const evidence = Array.from({ length: evidenceCount }, (_, index) => {
    const base = {
      evidenceId: `viewport-${index + 1}`,
      uri: `https://evidence.example/item-${index + 1}.png?signature=hidden-${index + 1}`,
      sha256: String(index).padStart(64, "0"),
    };
    if (!artifactMode) return base;
    if (artifactMode === "video") return {
      evidenceId: "interaction-clip",
      artifactId: "art_clip",
      mediaType: "video/webm",
      sha256: artifactDigests.get("art_clip")!,
    };
    if ((artifactMode === "mixed" || artifactMode === "unrenderable") && index === 1) return base;
    if (artifactMode === "unrenderable" && index === 2) {
      return { ...base, evidenceId: "vector-diagram", uri: "https://evidence.example/diagram.svg?signature=hidden-svg",
        artifactId: "art_svg", mediaType: "image/svg+xml" };
    }
    if (artifactMode === "unrenderable" && index === 3) {
      return { ...base, evidenceId: "untyped-capture", artifactId: "art_untyped" };
    }
    if (artifactMode === "mixed" && index === 2) {
      return { ...base, evidenceId: "interaction-clip", artifactId: "art_clip", mediaType: "video/webm",
        sha256: artifactDigests.get("art_clip")! };
    }
    const artifact = {
      ...base,
      artifactId: `art_${index + 1}`,
      mediaType: "image/png",
      sha256: artifactMode === "mismatch" && index === 1 ? "f".repeat(64) : artifactDigests.get(`art_${index + 1}`)!,
    };
    if (artifactMode === "artifact-only") {
      const { uri: _externalCopy, ...withoutUri } = artifact;
      return withoutUri;
    }
    return artifact;
  });
  return {
    id: "evidence-session",
    runnerId: "runner",
    workspaceId: null,
    workspaceName: null,
    title: "Responsive Evidence Review",
    status: "input_required",
    eventEpoch: 3,
    updatedAt: Date.now(),
    pendingApproval: {
      requestId: "evidence-occurrence",
      occurrenceId: "evidence-occurrence",
      kind: "workflow_decision",
      title: "UI Evidence Approval Required",
      context: { input: JSON.stringify({ evidence }) },
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      workflowDecision: {
        requestId: "evidence-request",
        occurrenceId: "evidence-occurrence",
        sessionId: "evidence-session",
        controllingSessionId: "parent",
        category: "ui_evidence_approval",
        resourceKey: "pr-1107-ui",
        resourceSnapshot: { category: "ui_evidence_approval", evidence },
        resourceDigest: "a".repeat(64),
        policyRevision: 1,
        authority: "human",
        status: "pending",
        createdAt: Date.now() - 40_000,
      },
    },
  } as SessionView;
}

function issueClosureSession(): SessionView {
  const base = evidenceSession();
  const snapshot = { category: "issue_closure" as const, repository: "team/repo", issue: 123,
    title: "Obsolete Task", url: "https://github.com/team/repo/issues/123", forgeDigest: "a".repeat(64),
    reason: "not_planned" as const, explanation: "The replacement design makes this task obsolete.",
    evidence: ["Replacement issue #124 covers the current design."], comment: "Retired in favor of #124.",
    openPullRequests: [{ number: 77, title: "Earlier Implementation", url: "https://github.com/team/repo/pull/77", headSha: "b".repeat(40) }],
    activeChildren: [{ sessionId: "child", title: "Implement Issue 123", assignmentDigest: "c".repeat(64) }],
  };
  return { ...base, title: "Campaign Issue Closure", pendingApproval: {
    ...base.pendingApproval!, title: "Issue Closure Approval Required", context: { input: JSON.stringify(snapshot) },
    workflowDecision: { ...base.pendingApproval!.workflowDecision!, category: "issue_closure", resourceSnapshot: snapshot,
      controllingSessionId: base.id, authority: "human" },
  } };
}

function standaloneApprovalSession(): SessionView {
  return {
    ...evidenceSession(),
    id: "worktree-setup-session",
    title: "Worktree Setup",
    pendingApproval: {
      requestId: "worktree-setup:one:hash",
      occurrenceId: "worktree-setup-occurrence",
      kind: "permission",
      title: "Trust Worktree Setup Configuration?",
      context: {
        toolName: "wollipog.worktree_setup",
        path: "/workspace/project",
        branch: "fix/responsive-approval",
        input: [
          "Copies:",
          ...Array.from({ length: 12 }, (_, index) => `  config/example-${index + 1}.env -> .env-${index + 1}`),
          "Commands:",
          ...Array.from({ length: 12 }, (_, index) => `  pnpm setup:step-${index + 1}`),
          "Environment: API_BASE_URL, PORT, WOLLIPOG_PROJECT",
        ].join("\n"),
      },
      options: [
        { optionId: "trust", name: "Trust This Configuration", kind: "allow_always" },
        { optionId: "skip", name: "Create Without Setup", kind: "reject_once" },
      ],
    },
  } as SessionView;
}

function descendantRequests(): DescendantRequestView[] {
  return Array.from({ length: 12 }, (_, index) => {
    const orchestrator = index % 3 === 2;
    return {
      sessionId: `child-${index + 1}`,
      sessionTitle: `Child Session ${index + 1}`,
      runnerId: "runner",
      runnerOnline: true,
      eventEpoch: index + 1,
      createdAt: Date.now() - ((index + 1) * 60_000),
      responseOwner: orchestrator ? "orchestrator" : "human",
      occurrenceId: `occurrence-${index + 1}`,
      request: index === 0 ? {
        requestId: "child-evidence",
        occurrenceId: "occurrence-1",
        kind: "workflow_decision",
        title: "Child UI Evidence Approval",
        options: [
          { optionId: "approve", name: "Approve", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        workflowDecision: {
          requestId: "child-evidence-request",
          occurrenceId: "occurrence-1",
          sessionId: "child-1",
          controllingSessionId: "parent",
          category: "ui_evidence_approval",
          resourceKey: "pr-1107-child-ui",
          resourceSnapshot: {
            category: "ui_evidence_approval",
            evidence: [{
              evidenceId: "child-viewport",
              uri: "https://evidence.example/child.png?signature=hidden-child",
              sha256: "d".repeat(64),
            }],
          },
          resourceDigest: "e".repeat(64),
          policyRevision: 1,
          authority: "human",
          status: "pending",
          createdAt: Date.now() - 60_000,
        },
      } : orchestrator ? {
        requestId: `merge-${index + 1}`,
        occurrenceId: `occurrence-${index + 1}`,
        kind: "workflow_decision",
        title: "PR Merge Approval Required",
        options: [
          { optionId: "approve", name: "Approve", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        workflowDecision: {
          requestId: `merge-request-${index + 1}`,
          occurrenceId: `occurrence-${index + 1}`,
          sessionId: `child-${index + 1}`,
          controllingSessionId: "parent",
          category: "pr_merge",
          resourceKey: `pr-${100 + index}`,
          resourceSnapshot: {
            category: "pr_merge",
            repository: "picoduck/wollipog",
            pullRequest: 100 + index,
            headSha: "b".repeat(40),
            reviewResult: "merge",
            requiredChecks: { headSha: "b".repeat(40), status: "passed", checkedAt: 1, checks: [] },
          },
          resourceDigest: "c".repeat(64),
          policyRevision: 1,
          authority: "orchestrator",
          status: "pending",
          createdAt: Date.now() - ((index + 1) * 60_000),
        },
      } : {
        requestId: `question-${index + 1}`,
        occurrenceId: `occurrence-${index + 1}`,
        kind: "question",
        title: "Question",
        options: [],
        questions: [{
          id: "target",
          question: `Choose the deployment target for child ${index + 1}`,
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    } satisfies DescendantRequestView;
  });
}

type CampaignContinuation = NonNullable<NonNullable<SessionView["orchestratorCampaign"]>["continuation"]>;

const CONTINUATION_STATES = ["missing_result", "failed", "failed-auto", "pending", "running", "held"] as const;

function continuationFor(state: string): CampaignContinuation {
  const base = {
    pendingEvents: 3,
    continuationId: `campaign_cont_${state}`,
    commandId: "campaign_prompt_evidence",
    eventFromSeq: 8,
    eventThroughSeq: 10,
    attemptCount: 2,
    updatedAt: Date.now(),
  };
  if (state === "failed" || state === "failed-auto") {
    return {
      ...base,
      state: "failed",
      attemptCount: 5,
      error: "Runner queue remained full after 5 attempts (runner-7 rejected the prompt: queue_full).",
      ...(state === "failed" ? { canRetry: true } : {}),
    };
  }
  if (state === "pending" || state === "running" || state === "held") return { ...base, state };
  return {
    ...base,
    state: "missing_result",
    error: "Provider accepted the turn but no terminal result was persisted.",
    canAcknowledgeMissingResult: true,
  };
}

function continuationSession(): SessionView {
  return {
    ...evidenceSession(),
    id: "campaign-session",
    title: "Durable Campaign Recovery",
    status: "idle",
    pendingApproval: null,
    orchestratorCampaign: {
      status: "active",
      policyRevision: 7,
      decisionOwners: {
        implementation_question: "orchestrator",
        pr_merge: "human",
        merged_branch_deletion: "human",
        follow_up_issue_publication: "human",
        ui_evidence_approval: "human",
      },
      limits: { maximumConcurrentChildren: 4, occupied: 2, remaining: 2, costBudgetUsd: null, maxToolCalls: null },
      uiEvidenceReview: { status: "available", effectiveOwner: "orchestrator" },
      children: { total: 4, active: 1, waitingHuman: 0, blocked: 0, verified: 2, cleanupPending: 1 },
      pendingDecisions: { human: 0, orchestrator: 1 },
      followUps: { unique: 0, duplicates: 0 },
      continuation: continuationFor(continuationParam),
    },
  } as SessionView;
}

const HELD_CHILD_TITLES: Record<string, string> = {
  "held-child-1": "Fix #1650: Keep a Decision Resume Across Worktree Recovery",
  "held-child-2": "Fix #1651: Queue Prompts Behind a Handoff Barrier",
  "held-child-3": "Fix #1778: Bound a Handoff Held by a Never-Ending Job",
};

/** A child whose worktree handoff waits on a monitor that never fires, with the runner's bound
 * (#1778). The reason and recovery action come from the protocol, as the control plane derives them. */
function boundedHandoffHeldChild() {
  const since = Date.now() - 41 * 60_000;
  const [hold] = sessionHolds({
    queueHold: {
      kind: "worktree_rebind",
      holdId: `worktree-rebind:${since}`,
      since,
      target: "/home/dev/worktrees/issue-1778",
      queuedPrompts: 2,
      unfinishedBackgroundJobs: 1,
      oldestUnfinishedJob: { launchType: "monitor", startedAt: since - 36 * 60_000 },
      ...(boundedParam === "1" ? { endsAt: since + 60 * 60_000 } : {}),
      ...(restartKeepsQueue ? { restartKeepsQueue: true as const } : {}),
      ...(stoppableJobs ? { canStopJobs: true as const } : {}),
    },
  }, [{ kind: "workflow_decision_resolution", occurrenceId: "wd_occ_merge_1778", since: since + 60_000 }],
  heldChildReader);
  return { sessionId: "held-child-3", holds: [hold!] };
}

/** A campaign whose projection holds two children: one in worktree recovery with a held decision
 * resume, and one with a hold kind this client predates. A third blocked child failed (#1760). */
function heldCampaignSession(): SessionView {
  const base = continuationSession();
  return {
    ...base,
    title: "Issue Campaign With Held Children",
    status: "running",
    orchestratorCampaign: {
      ...base.orchestratorCampaign!,
      status: "blocked",
      continuation: scenario === "both" ? continuationFor("failed") : undefined,
      children: { total: 5, active: 1, waitingHuman: 1, blocked: boundedHold ? 1 : 3, verified: 0, cleanupPending: 0 },
      pendingRequests: { human: 8, orchestrator: 4 },
      heldChildren: boundedHold ? [boundedHandoffHeldChild()] : [
        {
          sessionId: "held-child-1",
          // The reason and recovery action come from the protocol, as the control plane derives them.
          holds: sessionHolds({
            worktreeRecovery: {
              recoveryId: "recovery-held-child-1",
              detectedAt: Date.now() - 7 * 60_000,
              selectedPath: "/home/dev/worktrees/issue-1650",
              expectedBranch: "fix/issue-1650-decision-resume",
              detail: "The selected worktree /home/dev/worktrees/issue-1650 is on branch main, not " +
                "fix/issue-1650-decision-resume.",
            },
          }, [{
            kind: "workflow_decision_resolution",
            occurrenceId: "wd_occ_merge_1752",
            since: Date.now() - 3 * 60_000,
          }], heldChildReader),
        },
        {
          sessionId: "held-child-2",
          holds: [{
            // A runner-side hold kind this client predates renders from its own fields.
            kind: "handoff_barrier" as never,
            holdId: "barrier-held-child-2",
            since: Date.now() - 90_000,
            reason: "A prompt is queued behind a conversation handoff that has not finished.",
            recoveryAction: "Finish or cancel the handoff; the queued prompt is delivered once it clears.",
          }],
        },
      ],
    },
  } as SessionView;
}

/** A session's own requests for the dock (#2179), by scenario. Each is a real request shape: the
 * options are in the provider's order, which the card's footer reorders. */
function permissionRequest(): PendingApproval {
  return {
    requestId: "permission-deploy",
    occurrenceId: "permission-deploy",
    kind: "permission",
    title: "Run pnpm deploy?",
    context: {
      toolName: "Bash",
      path: "/workspace/project",
      branch: "fix/request-dock",
      input: tallBody
        ? Array.from({ length: 60 }, (_, index) => `pnpm deploy --step ${index + 1} --target production`).join("\n")
        : "pnpm deploy --target production",
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      {
        optionId: "allow-always",
        name: "Always Allow in This Session",
        description: "Allows pnpm deploy without asking until the session ends.",
        kind: "allow_always",
      },
      { optionId: "deny", name: "Reject", kind: "reject_once" },
    ],
  };
}

function policyRequest(): PendingApproval {
  return {
    requestId: "policy-ask",
    occurrenceId: "policy-ask",
    kind: "policy_hook",
    title: "Bash requires approval.",
    governancePolicyId: "deploy-guard",
    expiresAt: Date.now() + (9 * 60 + 42) * 1000,
    context: { toolName: "Bash", path: "/workspace/project", input: "pnpm deploy --target production" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  };
}

function budgetRequest(): PendingApproval {
  return {
    requestId: "cost-budget:session:1",
    kind: "cost_budget",
    title: "Cost budget reached — $5.02 of $5.00. Continue?",
    options: [
      { optionId: "continue", name: "Continue", kind: "allow_once" },
      { optionId: "cancel", name: "Stop", kind: "reject_once" },
    ],
  };
}

function toolCallsRequest(): PendingApproval {
  return {
    requestId: "max-tool-calls:session:1",
    kind: "max_tool_calls",
    title: "Tool-call limit reached — 200 of 200 tool calls. Continue?",
    options: [
      { optionId: "continue", name: "Continue", kind: "allow_once" },
      { optionId: "cancel", name: "Stop", kind: "reject_once" },
    ],
  };
}

function workflowRequest(): PendingApproval {
  return {
    requestId: "merge-occurrence",
    occurrenceId: "merge-occurrence",
    kind: "workflow_decision",
    title: "PR Merge Approval Required",
    options: [
      { optionId: "approve", name: "Approve", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    workflowDecision: {
      requestId: "merge-request",
      occurrenceId: "merge-occurrence",
      sessionId: "dock-session",
      controllingSessionId: "parent",
      category: "pr_merge",
      resourceKey: "pr-2179",
      resourceSnapshot: {
        category: "pr_merge",
        repository: "picoduck/wollipog",
        pullRequest: 2179,
        headSha: "c0ffee".repeat(6) + "c0ff",
        reviewResult: "merge",
        requiredChecks: { headSha: "c0ffee".repeat(6) + "c0ff", status: "passed", checkedAt: 1, checks: [] },
      },
      resourceDigest: "d".repeat(64),
      policyRevision: 1,
      authority: "human",
      status: "pending",
      createdAt: Date.now() - 3 * 60_000,
    },
  };
}

function signInRequest(): PendingApproval {
  return {
    requestId: "auth:claude",
    kind: "authentication",
    title: "Sign In to Claude Code",
    options: [
      {
        optionId: "auth:login",
        name: "Start Sign-In",
        description: "Run the provider's login flow in this exact runner context. Output stays on the runner.",
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
  };
}

const DOCK_SCENARIOS: Record<string, { title: string; requests: () => PendingApproval[] }> = {
  permission: { title: "Deploy the Request Dock", requests: () => [permissionRequest()] },
  policy: { title: "Deploy Behind a Policy", requests: () => [policyRequest()] },
  budget: { title: "Budgeted Session", requests: () => [budgetRequest()] },
  "tool-calls": { title: "Tool-Limited Session", requests: () => [toolCallsRequest()] },
  workflow: { title: "Campaign Merge", requests: () => [workflowRequest()] },
  // Arrival order: the permission came first, the sign-in last. The dock orders them by priority.
  multiple: { title: "Three Requests at Once", requests: () => [permissionRequest(), budgetRequest(), signInRequest()] },
};

function dockSession(): SessionView {
  const entry = DOCK_SCENARIOS[scenario]!;
  const [first, ...rest] = entry.requests();
  return {
    ...evidenceSession(),
    id: "dock-session",
    title: entry.title,
    agentName: "Claude Code",
    driver: "claude-code",
    pendingApproval: { ...first!, ...(rest.length ? { additionalRequests: rest } : {}) },
  } as SessionView;
}

function noticeEntries(): SessionNoticeEntry[] {
  if (!withNotices) return [];
  return [
    {
      key: "composer-error",
      severity: "danger",
      rank: SESSION_NOTICE_RANK.composerError,
      title: "Message Not Sent",
      render: ({ trailing }) => (
        <Notice tone="danger" title="Message Not Sent" trailing={trailing}>
          Couldn't send your message. Try again.
        </Notice>
      ),
    },
    {
      key: "skills",
      severity: "info",
      rank: SESSION_NOTICE_RANK.skillsUnavailable,
      title: "Skills Unavailable",
      render: ({ trailing, onDismiss }) => (
        <Notice tone="info" title="Skills Unavailable" trailing={trailing} onDismiss={onDismiss}>
          This container session can't use the skills on your machine.
        </Notice>
      ),
    },
  ];
}

/** A and D, routed as the session's reading keys route them: to the dock's expanded request. */
function ReadingKeys({ intentRef, scrollRef }: {
  intentRef: MutableRefObject<RequestIntentHandler | null>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const noop = () => {};
  useSessionReadingKeys({
    enabled: true,
    sessionId: "dock-session",
    scrollRef,
    actions: {
      nextSession: noop,
      previousSession: noop,
      approve: () => { intentRef.current?.("approve"); },
      deny: () => { intentRef.current?.("deny"); },
      archive: noop,
      snooze: noop,
      fork: noop,
      reply: noop,
      pauseFollow: noop,
      resumeFollow: noop,
    },
  });
  return null;
}

function Fixture() {
  const [session, setSession] = useState(() => scenario === "issue-closure" ? issueClosureSession() : scenario === "continuation"
    ? continuationSession()
    : scenario === "held" || scenario === "both"
    ? heldCampaignSession()
    : scenario === "gallery"
    ? continuationSession()
    : scenario === "descendants" || scenario === "polling" ? {
        ...evidenceSession(),
        status: "running",
        pendingApproval: null,
        orchestratorCampaign: {
          pendingRequests: scenario === "descendants"
            ? { human: 8, orchestrator: 4 }
            : { human: 1, orchestrator: 0 },
        } as SessionView["orchestratorCampaign"],
      } as SessionView
    : scenario === "standalone" || scenario === "worker"
      ? {
          ...standaloneApprovalSession(),
          pendingApproval: scenario === "worker"
            ? { ...standaloneApprovalSession().pendingApproval!, ownerToolUseId: "worker-tool" }
            : standaloneApprovalSession().pendingApproval,
        } as SessionView
      : DOCK_SCENARIOS[scenario] ? dockSession()
      // The transcript's own artifacts, with no request pending.
      : scenario === "artifact-timeline" ? { ...evidenceSession(), status: "running", pendingApproval: null } as SessionView
      : evidenceSession());
  const viewedSession = respondAs === "viewer" ? {
    ...session,
    commandPermissions: {
      stop: { allowed: true },
      restart: { allowed: true },
      stopBackgroundJob: { allowed: true },
      respond: { allowed: false, reason: "Your Viewer role can read this session but not answer its requests." },
    },
  } as SessionView : session;
  const descendants = useMemo(() => includeDescendants ? descendantRequests() : [], []);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RightPanelMode>("requests");
  const [width, setWidth] = useState(420);
  clearHold = (sessionId: string) => setSession((current) => {
    const campaign = current.orchestratorCampaign!;
    const heldChildren = (campaign.heldChildren ?? []).filter((child) => child.sessionId !== sessionId);
    return {
      ...current,
      orchestratorCampaign: {
        ...campaign,
        children: { ...campaign.children, active: campaign.children.active + 1, blocked: campaign.children.blocked - 1 },
        ...(heldChildren.length ? { heldChildren } : { heldChildren: undefined }),
      },
    } as SessionView;
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(() => includeDescendants
    ? sessionRequestPanelKey(descendants[0]!.sessionId, descendants[0]!.occurrenceId)
    : null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const state: RightPanelState = {
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
  const client = {
    ...api,
    artifactExport: async (artifactId: string) => {
      artifactRequests.push(artifactId);
      const bytes = artifactBytes.get(artifactId);
      if (!bytes || (artifactMode === "unavailable" && artifactId === "art_2")) {
        throw new ApiError("artifact not found", 404);
      }
      return new Blob([bytes], { type: artifactId === "art_clip" ? "video/webm" : "image/png" });
    },
    governancePolicies: async () => ({ policies: [{
      policyId: "deploy-guard", name: "Deploy Guard", effect: "ask", priority: 1, enabled: true, scope: {},
      askTimeout: 600, createdAt: 1, updatedAt: 1,
    }] }),
    approve: async (sessionId: string, body: { requestId: string; optionId: string | null }) => {
      submissions.push(structuredClone(body));
      if (failNextDecision) {
        failNextDecision = false;
        throw new ApiError("The runner did not accept the decision.", 503);
      }
      if (sessionId !== session.id) {
        setOpen(false);
        return session;
      }
      // Only the decided request leaves; the others stay pending in their order.
      const remaining = removePendingRequest(session.pendingApproval, body.requestId);
      const updated = { ...session, status: remaining ? "input_required" : "running", pendingApproval: remaining } as SessionView;
      setSession(updated);
      return updated;
    },
    resolvePendingPrompt: async (_sessionId: string, commandId: string, action: "cancel" | "dismiss" | "retry") => {
      submissions.push({ commandId, action });
      const updated = {
        ...session,
        orchestratorCampaign: session.orchestratorCampaign
          ? { ...session.orchestratorCampaign, continuation: undefined }
          : undefined,
      } as SessionView;
      setSession(updated);
      return updated;
    },
  } as ApiClient;
  const standaloneTemplate = scenario === "issue-closure" ? issueClosureSession().pendingApproval! : scenario === "standalone" || scenario === "worker"
    ? standaloneApprovalSession().pendingApproval!
    // Only a provider's permission has a transcript row; a policy ask or a pause is the control plane's.
    : DOCK_SCENARIOS[scenario]?.requests().find((request) => request.kind === "permission") ?? null;
  const standaloneTimelineItems: TimelineItem[] = standaloneTemplate ? [{
    kind: "permission",
    id: 25,
    requestId: standaloneTemplate.requestId,
    title: standaloneTemplate.title,
    options: standaloneTemplate.options,
    context: standaloneTemplate.context,
    createdAt: Date.now() - 2 * 60_000,
    ...(pendingRequests(session.pendingApproval).some((request) => request.requestId === standaloneTemplate.requestId)
      ? {}
      : { resolvedOptionId: (submissions.at(-1) as { optionId?: string } | undefined)?.optionId ?? "trust",
        resolutionReason: "submitted" as const }),
  }] : [];
  const artifactTimelineItems: TimelineItem[] = scenario === "artifact-timeline" ? [
    ...(artifactMode === "ready" ? Array.from({ length: 24 }, (_, index): TimelineItem =>
      ({ kind: "user_message", id: 100 + index, text: `Earlier transcript message ${index + 1}` })) : []),
    {
      kind: "artifact_attached", id: 26, createdAt: Date.now(), artifact: {
        artifactId: artifactMode === "ready" ? "art_1" : "art_clip", sessionId: session.id,
        kind: artifactMode === "ready" ? "screenshot" : "video",
        name: artifactMode === "ready" ? "Session Screenshot.png" : "Session Walkthrough.webm",
        mimeType: artifactMode === "ready" ? "image/png" : "video/webm", encoding: "base64",
        sizeBytes: artifactBytes.get(artifactMode === "ready" ? "art_1" : "art_clip")?.byteLength ?? 0,
        sha256: artifactDigests.get(artifactMode === "ready" ? "art_1" : "art_clip")!,
        createdBy: { kind: "agent", id: session.id }, createdAt: Date.now(),
      },
    },
    ...(artifactMode === "ready" ? Array.from({ length: 40 }, (_, index): TimelineItem =>
      ({ kind: "user_message", id: 200 + index, text: `Later transcript message ${index + 1}` })) : []),
  ] : [];
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const intentRef = useRef<RequestIntentHandler | null>(null);
  const docked = dockRequests(prioritizedPendingRequests(session.pendingApproval));
  const permissionTimes = new Map(standaloneTimelineItems.flatMap((item) =>
    item.kind === "permission" && item.createdAt ? [[item.requestId, item.createdAt] as const] : []));
  const lead: SessionNoticeLead | undefined = docked.length > 0 ? {
    key: "request-dock",
    title: pendingRequestsTitle(docked.length),
    icon: <RequestKindIcon request={docked[0]!} />,
    requestIds: docked.map((request) => request.requestId),
    render: ({ trailing, revealRequestId }) => (
      <RequestDock
        session={viewedSession}
        requests={docked}
        runnerOnline={runnerOnline}
        owner="Claude Code"
        createdAt={(request) => request.workflowDecision?.createdAt ?? permissionTimes.get(request.requestId)}
        headTrailing={trailing}
        onSessionUpdate={setSession}
        showKeyHints
        intentRef={intentRef}
        keyboardOpen={keyboardOpen}
        revealRequestId={revealRequestId}
      />
    ),
  } : undefined;

  return (
    <ApiProvider client={client}>
      <ReadingKeys intentRef={intentRef} scrollRef={scrollRef} />
      <main className="app" style={{ display: "block", height: "100dvh" }}>
        <section className="session-detail expanded" style={{ height: "100%" }}>
          <header className="detail-bar session-bar" style={{ justifyContent: "space-between" }}>
            <h1 className="detail-bar-title session-bar-title">{session.title}</h1>
            {scenario === "descendants" || scenario === "polling" || scenario === "held" ? (
              <SessionStatusIndicators
                session={session}
                onOpenAttention={() => setOpen(true)}
                onOpenCampaignRequests={() => setOpen(true)}
              />
            ) : <span />}
          </header>
          <div className="detail-columns">
            <div className="detail-chat">
              {/* As SessionDetail renders them: the head of the chat column, under the session bar. */}
              {(session.orchestratorCampaign?.continuation && (scenario === "continuation" || scenario === "both") ||
                scenario === "gallery" || (session.orchestratorCampaign?.heldChildren?.length ?? 0) > 0) && (
                <div className="campaign-notices">
                  {(scenario === "continuation" || scenario === "both") && session.orchestratorCampaign?.continuation && (
                    <CampaignContinuationNotice
                      continuation={session.orchestratorCampaign.continuation}
                      acknowledgementPending={continuationBusy}
                      actionRefusal={continuationRefusal}
                      onAcknowledge={(commandId) => void client.resolvePendingPrompt(session.id, commandId, "dismiss")}
                      onRetry={(commandId) => void client.resolvePendingPrompt(session.id, commandId, "retry")}
                    />
                  )}
                  {scenario === "gallery" && CONTINUATION_STATES.map((state) => (
                    <CampaignContinuationNotice
                      key={state}
                      continuation={continuationFor(state)}
                      onAcknowledge={() => {}}
                      onRetry={() => {}}
                    />
                  ))}
                  {(scenario === "held" || scenario === "both") && session.orchestratorCampaign && (
                    <CampaignHeldChildren
                      heldChildren={session.orchestratorCampaign.heldChildren ?? []}
                      blocked={session.orchestratorCampaign.children.blocked}
                      childTitle={(id) => HELD_CHILD_TITLES[id]}
                      onOpenChild={(id) => { openedHeldChild = id; }}
                    />
                  )}
                </div>
              )}
              <SessionApprovalRegion
                session={viewedSession}
                runnerOnline={runnerOnline}
                fallbackFocusRef={composerRef}
                onSessionUpdate={setSession}
                showKeyHints={false}
              />
              <div className="chat-reading">
                <div className="detail-main">
                  <div className="detail-reader">
                    <div className="detail-scroll measured-virtual-scroll" role="region" aria-label="Session Activity"
                      ref={scrollRef} tabIndex={0}>
                      {Array.from({ length: scenario === "artifact-timeline" ? 0 : 24 }, (_, index) => (
                        <div className={`tl-row ${index % 2 ? "agent" : "user"}`} key={index}>
                          <div className={index % 2 ? "tl-agent-msg" : "tl-bubble"}>
                            Transcript message {index + 1}
                          </div>
                        </div>
                      ))}
                      {(standaloneTimelineItems.length > 0 || scenario === "artifact-timeline") && (
                        <EventTimeline
                          items={scenario === "artifact-timeline" ? artifactTimelineItems : standaloneTimelineItems}
                          scrollRef={scenario === "artifact-timeline" ? scrollRef : undefined}
                          historyKey={scenario === "artifact-timeline" ? `${session.id}:0` : undefined}
                        />
                      )}
                    </div>
                  </div>
                </div>
                {lead && (
                  <SessionNoticeSlot sessionId={session.id} entries={noticeEntries()} lead={lead} />
                )}
              </div>
              <div className="composer"><div className="composer-box"><textarea ref={composerRef} className="composer-input" aria-label="Composer" /></div></div>
            </div>
            <RightPanel
              state={state}
              session={session}
              runnerOnline
              runnerProtocolVersion={999}
              onOpenSourceLocation={() => {}}
              onClearSourceLocation={() => {}}
              git={{
                status: null,
                observation: 0,
                observedAt: null,
                settled: true,
                busy: false,
                error: null,
                errorCode: null,
                refresh: async () => {},
                refreshStatusOnly: async () => {},
                install: () => {},
                mutationRevision: 0,
              }}
              onOpenTerminal={() => {}}
              onInsertSideChatDraft={() => {}}
              items={[]}
              descendantRequests={descendants}
              descendantRequestStatus={descendantRequestStatus}
              selectedRequestKey={selectedKey}
              onSelectedRequestKeyChange={setSelectedKey}
              onSessionUpdate={setSession}
              onDescendantsUpdate={() => {}}
              onOpenChildRequest={(request) => { openedChild = request; }}
            />
          </div>
        </section>
      </main>
    </ApiProvider>
  );
}

window.__WOLLIPOG_REQUEST_SURFACES_E2E__ = {
  openedChild: () => openedChild,
  submissions: () => submissions,
  artifactRequests: () => [...artifactRequests],
  openedHeldChild: () => openedHeldChild,
  clearHold: (sessionId) => clearHold(sessionId),
  failNextDecision: () => { failNextDecision = true; },
  reveal: (requestId) => focusSessionRequest("dock-session", requestId),
};

void prepareArtifacts().then(() => createRoot(document.getElementById("root")!).render(<Fixture />));
