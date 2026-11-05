/**
 * Campaign Status harness (#2417): the real right panel over a fixture campaign ledger.
 *
 * `scenario` picks the session the panel belongs to:
 * - `campaign` (default): the root Orchestrator with a recorded plan, recursive follow-ups, a
 *   blocked item waiting on a Request, partial pricing, and finished work behind the filter;
 * - `member`: a child of that campaign, whose current assignment is highlighted;
 * - `planless`: a campaign whose Orchestrator never recorded a plan, with untracked children;
 * - `legacy`: a campaign on a server without the ledger (no `work` on its projection);
 * - `unrelated`: a session outside any campaign.
 * `theme=light` switches the palette; `open=launcher` starts on the launcher instead of the mode, and
 * `open=requests` on Requests.
 * `forge=gitlab` moves the Campaign Status Panel item to a GitLab project in a nested namespace.
 * `scope=outdated-runner` or `scope=issue-limits` makes issue scope unavailable because a participating
 * Orchestrator's runner is older than the scope-change or Full Control issue-limit floor.
 * `refresh=failing` fails every work-list read after the first, so a ledger write (`bumpRevision`)
 * leaves the loaded list under a Couldn't Refresh Work Items notice.
 * With `budget=1`, `followUps=pending` puts the campaign at its follow-up limit with two follow-ups
 * waiting for the person's approval (#2940); Change Limit saves to the fixture.
 * `handoffs=after` finishes the campaign with two items handed to people (#4070); `handoffs=before`
 * is the same campaign as a server without handoffs reports it.
 * `owners=after` gives the owner a decision they kept and a merge the Orchestrator handed to them
 * (#4064); `owners=before` is the same campaign as a server without owner decisions reports it, the
 * merge still the Orchestrator's and the owner's decision nowhere in Wollipog.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  campaignIssueLimitsRequirement,
  campaignIssueScopeChangesRequirement,
  PROTOCOL_VERSION,
  type CampaignWorkItemDetail,
  type CampaignWorkItemHandoff,
  type CampaignWorkItemSummary,
  type ControlPlaneToUi,
  type DescendantRequestView,
  type SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { RightPanel, type RightPanelState } from "../components/RightPanel.js";
import { useCampaignStatusAvailability } from "../components/useCampaignStatus.js";
import { applyCampaignWorkFilters, type CampaignWorkFilters } from "../campaign-status.js";
import type { RightPanelMode } from "../right-panel.js";
import { StoreProvider } from "../store.js";
import type { ViewNavigation } from "../navigation.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { MINUTE, campaignProjection, forgeObservation, itemDetail, itemSummary, knownCost, workSummary } from "./campaign-status-fixtures.js";
import "../styles.css";
import { campaignRecoveryFixture } from "./campaign-recovery-fixtures.js";

declare global {
  interface Window {
    __WOLLIPOG_CAMPAIGN_STATUS_E2E__: {
      /** Every work-list query the panel sent, in order. */
      queries(): string[];
      /** The session a panel link opened, if any. */
      openedSession(): string | null;
      /** The request Requests was asked to select, if any. */
      selectedRequestKey(): string | null;
      /** Moves the ledger forward one revision, as a ledger write re-sending the root would. */
      bumpRevision(): void;
      /** Navigates the harness to another session, as the app does. */
      navigate(sessionId: string): void;
      /** Every on-demand GitHub read the details asked for, as `session/item`. */
      forgeRefreshes(): string[];
    };
  }
}

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "campaign";
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";

const NOW = Date.now();
const recoveryReason = params.get("recovery");
const recoveryRecord = recoveryReason && ["missing_access", "missing_human_information", "boundary_enlargement",
  "human_required_rule", "unsupported_capability", "attempts_exhausted", "failed_checks", "reviewer_objection", "uncertain_outcome", "request_declined",
  "hard_denial", "intentional_stop", "unverified_stop"].includes(recoveryReason)
  ? campaignRecoveryFixture(recoveryReason as import("@wollipog/protocol").CampaignRecoveryReason, NOW, params.get("subject") === "worker") : null;
const HOUR = 60 * MINUTE;

const items: CampaignWorkItemSummary[] = [
  itemSummary("cwi_1", NOW, {
    title: "Campaign Work Ledger Contract", queuePosition: 1, primaryState: "delivered", dispatchState: "queued",
    elapsed: { startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR }, cost: knownCost(4.12), activityAt: NOW - 2 * HOUR,
    stage: { stage: "merged", note: null, pullRequests: [{ repository: "picoduck/wollipog", number: 2430 }], sourceSessionId: "s_root", reportedAt: NOW - 2 * HOUR },
  }),
  itemSummary("cwi_2", NOW, {
    title: "Campaign Status Panel", queuePosition: 2, primaryState: "running",
    currentAttempt: { id: "catt_2", sessionId: "s_child", sessionTitle: "#2417 Slice 7: Campaign Status Panel" },
    elapsed: { startedAt: NOW - 95 * MINUTE, endedAt: null }, cost: knownCost(6.4, "modelPriced", 3), activityAt: NOW - MINUTE,
    stage: {
      stage: "merge_queued",
      note: "Binding to the merged contract.",
      pullRequests: [2440, 2436, 2441].map((number) => ({ repository: "picoduck/wollipog", number })),
      sourceSessionId: "s_root",
      reportedAt: NOW - 20 * MINUTE,
    },
  }),
  itemSummary("cwi_3", NOW, {
    title: "Ledger Read API", queuePosition: 3, primaryState: "blocked", stateCauses: ["recorded_blocker"],
    currentAttempt: { id: "catt_3", sessionId: "s_child_3", sessionTitle: "#2417 Slice 5: Read API" },
    elapsed: { startedAt: NOW - 70 * MINUTE, endedAt: null }, cost: knownCost(2.05), activityAt: NOW - 8 * MINUTE,
    blocker: { reason: "Waiting for a merge decision on the storage pull request.", responsibleActor: "human", requestOccurrenceId: "occ_1", recordedAt: NOW - 8 * MINUTE, recordedBySessionId: "s_root" },
  }),
  itemSummary("cwi_4", NOW, {
    title: "Time and Cost Attribution", queuePosition: 4, primaryState: "waiting", stateCauses: ["attempt_awaiting_verification"],
    currentAttempt: { id: "catt_4", sessionId: "s_child_4", sessionTitle: "#2417 Slice 6: Time and Cost" },
    elapsed: { startedAt: NOW - 50 * MINUTE, endedAt: null }, cost: { availability: "unavailable", reason: "not_authorized" }, activityAt: NOW - 3 * MINUTE,
  }),
  itemSummary("cwi_5", NOW, {
    title: "Observed GitHub Status", queuePosition: 5, primaryState: "queued", stateCauses: ["dependency_unfinished"],
    currentAttempt: null, attemptCount: 0, elapsed: { startedAt: null, endedAt: null }, createdAt: NOW - 3 * HOUR, activityAt: NOW - 3 * HOUR,
  }),
  itemSummary("cwi_6", NOW, {
    title: "Integration Coverage", issue: null, key: "plan:integration", queuePosition: 6, primaryState: "planned", dispatchState: "planned",
    currentAttempt: null, attemptCount: 0, elapsed: { startedAt: null, endedAt: null }, createdAt: NOW - 3 * HOUR, activityAt: NOW - 3 * HOUR,
  }),
  itemSummary("cwi_7", NOW, {
    title: "Retain Ledger History on Child Deletion", issue: { repository: "picoduck/wollipog", number: 2431 }, origin: "follow_up", generation: 1,
    queuePosition: 7, primaryState: "planned", dispatchState: "planned", currentAttempt: null, attemptCount: 0,
    elapsed: { startedAt: null, endedAt: null }, createdAt: NOW - 40 * MINUTE, activityAt: NOW - 40 * MINUTE,
  }),
  itemSummary("cwi_8", NOW, {
    title: "Nested Orchestrator Overhead Label", issue: null, key: "follow-up:nested-overhead", origin: "follow_up", generation: 2,
    queuePosition: 8, primaryState: "planned", dispatchState: "planned", currentAttempt: null, attemptCount: 0,
    elapsed: { startedAt: null, endedAt: null }, createdAt: NOW - 15 * MINUTE, activityAt: NOW - 15 * MINUTE,
  }),
  itemSummary("cwi_9", NOW, {
    title: "Standalone Campaign Dashboard", issue: null, key: "plan:dashboard", queuePosition: null, primaryState: "removed",
    commitment: "scope_removed", currentAttempt: null, attemptCount: 0, elapsed: { startedAt: null, endedAt: null },
    createdAt: NOW - 3 * HOUR, activityAt: NOW - HOUR,
  }),
];

const details: Record<string, CampaignWorkItemDetail> = Object.fromEntries(items.map((item) => [item.id, itemDetail(item)]));
details.cwi_2 = itemDetail(items[1]!, {
  dependsOn: [{ id: "cwi_1", key: "picoduck/wollipog#1", title: "Campaign Work Ledger Contract", primaryState: "delivered" }],
  nextAction: "Open the pull request once the read API lands.",
  attempts: [
    {
      ...itemDetail(items[1]!).attempts[0]!, id: "catt_2a", ordinal: 1, sessionId: null,
      session: { title: "#2417 Slice 7 (First Attempt)", harness: null, agentName: "Codex App Server", model: "gpt-5.5", effort: "high" },
      startedAt: NOW - 3 * HOUR, endedAt: NOW - 95 * MINUTE, endReason: "superseded",
    },
    {
      ...itemDetail(items[1]!).attempts[0]!, id: "catt_2", ordinal: 2,
      session: { title: "#2417 Slice 7: Campaign Status Panel", harness: { agentId: "claude-native", driver: "claude-code", context: { kind: "native" } }, agentName: "Claude Code (native)", model: "claude-opus-5-5", effort: "high" },
      startedAt: NOW - 95 * MINUTE,
    },
  ],
  currentAttempt: { id: "catt_2", sessionId: "s_child", sessionTitle: "#2417 Slice 7: Campaign Status Panel" },
  attemptCosts: [
    { attemptId: "catt_2a", cost: knownCost(1.1, "modelPriced") },
    { attemptId: "catt_2", cost: knownCost(5.3, "modelPriced", 3) },
  ],
  times: {
    elapsed: items[1]!.elapsed,
    queue: { availability: "known", value: 12 * MINUTE },
    waiting: { availability: "partial", value: 9 * MINUTE, reason: "history_unavailable" },
    active: { availability: "unavailable", reason: "not_collected" },
    asOf: NOW,
  },
  observed: {
    session: { availability: "fresh", value: { sessionId: "s_child", status: "running", archived: false, held: false, pendingRequests: 0 }, observedAt: NOW - MINUTE },
    // Slice 8: a merge-queue wait observed a minute ago, an older observation now stale, and one
    // the runner could not read.
    pullRequests: [
      { ref: { repository: "picoduck/wollipog", number: 2440 }, fact: { availability: "fresh", value: forgeObservation(), observedAt: NOW - MINUTE } },
      {
        ref: { repository: "picoduck/wollipog", number: 2436 },
        fact: {
          availability: "stale",
          value: forgeObservation({ state: "merged", reviewDecision: "approved", mergeQueue: null, mergeCommitSha: "dd08b41b6a0e2c4f1f0b7d4e5b9a3c2d1e0f9a8b",
            checks: { state: "passing", passing: 9, failing: 0, pending: 0 } }),
          observedAt: NOW - 25 * MINUTE,
        },
      },
      { ref: { repository: "picoduck/wollipog", number: 2441 }, fact: { availability: "unavailable", reason: "forge_unauthenticated" } },
    ],
  },
});
details.cwi_3 = itemDetail(items[2]!, {
  nextAction: "Answer the merge decision in Requests.",
  stage: { stage: "in_review", note: null, pullRequests: [{ repository: "picoduck/wollipog", number: 2436 }], sourceSessionId: "s_root", reportedAt: NOW - 30 * MINUTE },
  observed: {
    // A reader who can open the campaign but not the runner whose GitHub CLI reads it.
    pullRequests: [{ ref: { repository: "picoduck/wollipog", number: 2436 }, fact: { availability: "unavailable", reason: "not_authorized" } }],
    session: { availability: "stale", value: { sessionId: "s_child_3", status: "idle", archived: false, held: true, pendingRequests: 1 }, observedAt: NOW - 6 * MINUTE },
    cleanup: { availability: "fresh", value: { sessionId: "s_child_3", worktrees: [{ path: "/w/3", status: "refused", reason: 'the worktree has uncommitted changes (10 paths): "report.md", "notes.txt", "scratch-a.txt", "scratch-b.txt", "scratch-c.txt", "scratch-d.txt", "scratch-e.txt", "scratch-f.txt"; 2 more' }] }, observedAt: NOW - 6 * MINUTE },
  },
});
if (params.get("forge") === "gitlab") {
  // The panel item tracked in a GitLab project in a nested namespace (#3539): one merge request
  // observed on its merge train a minute ago (#3600), and one the runner's glab could not read.
  const repository = "gitlab.example.com/platform/agents/wollipog";
  const refs = [2440, 2436].map((number) => ({ repository, number }));
  const stage = { ...items[1]!.stage!, pullRequests: refs };
  items[1] = { ...items[1]!, issue: { repository, number: 2417 }, stage };
  details.cwi_2 = {
    ...details.cwi_2!, issue: { repository, number: 2417 }, stage,
    observed: {
      ...details.cwi_2!.observed,
      pullRequests: [
        {
          ref: refs[0]!,
          fact: {
            availability: "fresh", observedAt: NOW - MINUTE,
            value: {
              forge: "gitlab", state: "open", draft: false, headSha: "5c1e0b7a90f2c3d4e5f60718293a4b5c6d7e8f90", baseRef: "main",
              approvals: { approved: true, approvedBy: 2, left: 0 },
              pipeline: { id: 90142, status: "running" },
              mergeTrain: { status: "fresh", position: 2 },
              mergeCommitSha: null,
            },
          },
        },
        { ref: refs[1]!, fact: { availability: "unavailable", reason: "forge_unauthenticated" } },
      ],
    },
  };
}

const ROOT_TITLE = "#2417 Campaign Orchestrator";
const recordedWork = (revision: number) => workSummary(NOW, {
  revision,
  coverage: { untrackedChildren: 0, predatesLedger: false },
  counts: {
    committed: 8, delivered: 1, original: 6, followUp: 2, cancelled: 0, removed: 1,
    byState: { planned: 3, queued: 1, running: 1, waiting: 1, blocked: 1, delivered: 1, cancelled: 0, removed: 1 },
  },
  recommendations: { awaiting_adjudication: 1, accepted: 2, rejected: 1, deferred: 1, duplicate: 3 },
  obligations: { verification: 1, adjudication: 1, publication: 1, cleanup: 1 },
  elapsed: { startedAt: NOW - 3 * HOUR - 12 * MINUTE, endedAt: null },
  cost: {
    total: { availability: "partial", value: { usd: 14.82, source: "modelPriced", unpricedRecords: 3 }, reason: "unpriced_usage" },
    workItems: { availability: "partial", value: { usd: 12.57, source: "modelPriced", unpricedRecords: 3 }, reason: "unpriced_usage" },
    coordination: knownCost(2.25),
    unattributed: knownCost(0, "providerReported", 0, 0),
    attributedSince: NOW - 3 * HOUR,
    // Claude turns that billed their conversation's running total (#4069).
    ...(params.get("runningTotals") === "1" ? { runningTotalClaudeRecords: 2 } : {}),
  },
});

function baseSession(overrides: Partial<SessionView>): SessionView {
  return {
    id: "s_root", runnerId: "runner-1", workspaceId: null, agentId: "claude-native", driver: "claude-code",
    title: ROOT_TITLE, status: "running", adopted: false, eventEpoch: 1, archived: false, runId: null,
    parentSessionId: null, pendingApproval: null, createdAt: NOW - 3 * HOUR, updatedAt: NOW, lastEventAt: NOW,
    messageCount: 40, tokensIn: 0, tokensOut: 0, costUsd: 0, costBudgetUsd: null, maxToolCalls: null,
    ...overrides,
  } as SessionView;
}

/** `handoffs=before|after` (#4070): the agents are done. Every child is verified and cleaned up,
 * nothing is pending, every other committed item is delivered, and two unfinished items belong to
 * people: what `campaignTerminalStatus` turns into Complete with Handoffs, as its integration test
 * shows. The same fixture both ways: `before` is how a server without handoffs reports it. */
const handoffScenario = params.get("handoffs") === "before" || params.get("handoffs") === "after" ? params.get("handoffs") as "before" | "after" : null;
const HANDED_OFF: Record<string, CampaignWorkItemHandoff> = {
  cwi_3: { responsibleActor: "human", reason: "Private vulnerability reporting refused the agent's GitHub account.",
    nextAction: "File the security advisory from a maintainer account.", recordedAt: NOW - 12 * MINUTE, recordedBySessionId: "s_root" },
  cwi_6: { responsibleActor: "external", reason: "Integration runs need the hosting provider's change window.",
    nextAction: "Ask the provider to schedule the change window, then run the integration suite.", recordedAt: NOW - 8 * MINUTE, recordedBySessionId: "s_root" },
};
if (handoffScenario) {
  for (const [index, item] of items.entries()) {
    if (item.commitment !== "committed") continue;
    const handoff = HANDED_OFF[item.id];
    items[index] = { ...item, primaryState: handoff ? "planned" : "delivered", stateCauses: [], currentAttempt: null, blocker: null,
      ...(handoff && handoffScenario === "after" ? { handoff } : {}),
      ...(handoff ? {} : { elapsed: { startedAt: item.elapsed.startedAt ?? NOW - 2 * HOUR, endedAt: NOW - 20 * MINUTE } }) };
    details[item.id] = itemDetail(items[index]!, handoff ? { nextAction: handoff.nextAction } : {});
  }
}
const handoffWork = (rev: number) => ({ ...recordedWork(rev),
  counts: { committed: 8, delivered: 6, original: 6, followUp: 2, cancelled: 0, removed: 1,
    byState: { planned: 2, queued: 0, running: 0, waiting: 0, blocked: 0, delivered: 6, cancelled: 0, removed: 1 } },
  recommendations: { awaiting_adjudication: 0, accepted: 2, rejected: 1, deferred: 1, duplicate: 3 },
  obligations: { verification: 0, adjudication: 0, publication: 0, cleanup: 0 },
  ...(handoffScenario === "after" ? { elapsed: { startedAt: NOW - 3 * HOUR - 12 * MINUTE, endedAt: NOW - 8 * MINUTE } } : {}),
});
function handoffProjection(state: "before" | "after"): Partial<import("@wollipog/protocol").OrchestratorCampaignProjection> {
  const declined = { ...campaignRecoveryFixture("request_declined", NOW), state: state === "after" ? "resolved" as const : "blocked" as const };
  return {
    status: state === "after" ? "complete_with_handoffs" : "blocked",
    children: { total: 3, active: 0, waitingHuman: 0, blocked: 0, verified: 3, cleanupPending: 0 },
    limits: { maximumConcurrentChildren: 4, occupied: 0, remaining: 4, costBudgetUsd: 40, maxToolCalls: null },
    heldChildren: [],
    recovery: state === "after"
      ? { unattendedReady: false, automation: { state: "lifecycle_held" }, automatic: 0, waitingHuman: 0, blocked: 0, records: [declined], truncated: false }
      : { unattendedReady: false, automation: { state: "lifecycle_held",
        reason: "Original scoped work remains unfinished, but no current known recovery is eligible. Reconcile its original obligation before continuing." },
      automatic: 0, waitingHuman: 0, blocked: 1, records: [declined], truncated: false },
    ...(state === "after" ? { handoffs: { total: 2, items: Object.entries(HANDED_OFF).map(([id, handoff]) => {
      const item = items.find((candidate) => candidate.id === id)!;
      return { workItemId: id, key: item.key, title: item.title, issue: item.issue, primaryState: item.primaryState, handoff };
    }) } } : {}),
  };
}

let revision = 1;
const projectionFor = (rev: number) => campaignProjection(
  scenario === "legacy" ? null
    : scenario === "planless" ? workSummary(NOW, {
      revision: rev,
      planState: "not_recorded",
      coverage: { untrackedChildren: 2, predatesLedger: true },
      counts: {
        committed: 2, delivered: 0, original: 2, followUp: 0, cancelled: 0, removed: 0,
        byState: { planned: 0, queued: 0, running: 2, waiting: 0, blocked: 0, delivered: 0, cancelled: 0, removed: 0 },
      },
      recommendations: { awaiting_adjudication: 0, accepted: 0, rejected: 0, deferred: 0, duplicate: 0 },
      obligations: { verification: 0, adjudication: 0, publication: 0, cleanup: 0 },
      cost: undefined,
    })
      : handoffScenario ? handoffWork(rev) : recordedWork(rev),
  {
    limits: { maximumConcurrentChildren: 4, occupied: 3, remaining: 1, costBudgetUsd: 40, maxToolCalls: null },
    ...(params.get("budget") === "1" ? { budget: {
      authority: { version: 1 as const, costUsd: 100, toolCalls: 2000, concurrency: 4, acceptedFollowUps: 3, accounting: "managed_workers_only" as const, unpriced: "stop" as const },
      // `estimate=1`: recorded spend includes running Claude turns' live estimates (#3196).
      state: "active" as const, actual: { costUsd: 12, toolCalls: 100, ...(params.get("estimate") === "1" ? { includesEstimate: true } : {}) },
      outstanding: { costUsd: 50, toolCalls: 900 },
      remaining: { costUsd: 38, toolCalls: 1000 }, occupied: 3, acceptedFollowUps: params.get("followUps") === "pending" ? 4 : 1, reachedCheckpointsUsd: [],
      followUpApprovals: params.get("followUps") === "pending" ? { approved: 1, pending: [
        { occurrenceId: "workflow_follow_up_1", title: "Retry the Merge Group When Main Is Red" },
        { occurrenceId: "workflow_follow_up_2", title: "Show Runner Contention in Campaign Status" },
      ] } : { pending: [], approved: 0 },
      enforcement: "admission_and_best_effort_cancellation" as const, externalWorkers: "unsupported" as const,
      sessionLimits: {costBudgetUsd:40,maxToolCalls:null},rootAllocation:{sessionId:"s_parent",costUsd:25,toolCalls:500},costAccounting:"priced" as const,
    } } : {}),
    ...(recoveryRecord ? { recovery: { unattendedReady: false, automatic: recoveryRecord.state === "dispatched" ? 1 : 0,
      waitingHuman: recoveryRecord.state === "waiting_human" ? 1 : 0, blocked: recoveryRecord.state === "blocked" ? 1 : 0,
      records: [recoveryRecord], truncated: false } } : {}),
    ...(params.get("completedChildren") === "1" && recoveryRecord?.reason === "failed_checks" ? {
      // Static rendering only. Actual fresh authority/forge/completion composition is separately
      // exercised in the CP-to-runner journal test; these values cannot attest live readiness.
      status: "active" as const,
      children: { total: 2, active: 0, waitingHuman: 0, blocked: 0, verified: 2, cleanupPending: 0 },
      limits: { maximumConcurrentChildren: 4, occupied: 0, remaining: 4, costBudgetUsd: 40, maxToolCalls: null },
    } : {}),
    heldChildren: params.get("completedChildren") === "1" ? [] : [{
      sessionId: "s_child_3",
      holds: [{
        kind: "provider_account_switch", holdId: "hold_1", since: NOW - 6 * MINUTE,
        reason: "The next turn waits while the provider account switches.",
        recoveryAction: "Restart the session once the account is ready.",
      }],
    }],
    ...(handoffScenario ? handoffProjection(handoffScenario) : {}),
    ...ownerProjection,
  },
);

/** `owners=after` (#4064): the root's question for its owner, and a child's merge handed to them. */
const ownerScenario = params.get("owners") === "before" || params.get("owners") === "after" ? params.get("owners") as "before" | "after" : null;
const ownerSnapshot = { category: "owner_decision" as const, question: "Which credential design should the provider bridge use?",
  material: "PR picoduck/wollipog#4141 at head 3f9c2e1. Both designs pass CI; the broker adds a helper process the owner would run.",
  recommendedOptionId: "lease", options: [
    { optionId: "lease", label: "Short-Lived Lease", description: "Credentials expire with the session." },
    { optionId: "broker", label: "Broker Process", description: "A helper holds credentials for every session." },
  ] };
const ownerCard: import("@wollipog/protocol").PendingApproval | null = ownerScenario === "after" ? {
  requestId: "workflow_owner_1", occurrenceId: "workflow_owner_1", kind: "workflow_decision", title: "Owner Decision Required", async: true,
  options: [...ownerSnapshot.options.map((option) => ({ optionId: option.optionId, name: option.label, description: option.description, kind: "allow_once" as const })),
    { optionId: "__workflow_deny__", name: "Do Not Proceed", kind: "reject_once" }],
  context: { toolName: "Typed Workflow Decision", input: JSON.stringify(ownerSnapshot, null, 2) },
  workflowDecision: { requestId: "credential-design", occurrenceId: "workflow_owner_1", sessionId: "s_root", controllingSessionId: "s_root",
    category: "owner_decision", resourceKey: "credential-design", resourceSnapshot: ownerSnapshot, resourceDigest: "e".repeat(64), policyRevision: 1,
    authority: "human", authorityEvaluation: { owner: "human", basis: "human_required", reason: "owner_kept", operation: "owner_decision" },
    status: "pending", createdAt: NOW - 4 * MINUTE },
} : null;
const ownerProjection = ownerScenario === "after" ? { status: "waiting_human" as const, ownerDecisions: { total: 2, items: [
  { occurrenceId: "workflow_owner_1", sessionId: "s_root", category: "owner_decision" as const, summary: ownerSnapshot.question, handedOff: false, createdAt: NOW - 4 * MINUTE },
  { occurrenceId: "occ_1", sessionId: "s_child_3", category: "pr_merge" as const, summary: "Merge picoduck/wollipog#4141", handedOff: true, createdAt: NOW - 8 * MINUTE },
] } } : {};

/** The root's own Pending Decision cards for the follow-ups past the limit (`followUps=pending`). */
const followUpCards: import("@wollipog/protocol").PendingApproval[] = params.get("followUps") === "pending" ? ([
  ["workflow_follow_up_1", "Retry the Merge Group When Main Is Red"],
  ["workflow_follow_up_2", "Show Runner Contention in Campaign Status"],
] as Array<[string, string]>).map(([occurrenceId, title]) => ({
  requestId: occurrenceId, occurrenceId, kind: "workflow_decision" as const, title: "Follow-Up Approval Required",
  options: [{ optionId: "approve", name: "Approve", kind: "allow_once" as const }, { optionId: "deny", name: "Deny", kind: "reject_once" as const }],
  workflowDecision: { requestId: `request-${occurrenceId}`, occurrenceId: occurrenceId!, sessionId: "s_root", controllingSessionId: "s_root",
    category: "campaign_follow_up_admission" as const, resourceKey: `campaign_follow_up_admission:s_root:work_item:${occurrenceId}`,
    resourceSnapshot: { category: "campaign_follow_up_admission" as const, subject: { kind: "work_item" as const, key: occurrenceId! }, title: title!, issue: null, identityDigest: "d".repeat(64), acceptedFollowUps: 3, limit: 3 },
    resourceDigest: "f".repeat(64), policyRevision: 1, authority: "human" as const, status: "pending" as const, createdAt: NOW - 5 * MINUTE },
})) : [];

function sessionsFor(rev: number): SessionView[] {
  const root = baseSession({ orchestratorCampaign: projectionFor(rev),
    ...(followUpCards.length ? { pendingApproval: { ...followUpCards[0]!, additionalRequests: followUpCards.slice(1) } } : {}),
    ...(ownerCard ? { pendingApproval: ownerCard } : {}) });
  const child = baseSession({
    id: "s_child", title: "#2417 Slice 7: Campaign Status Panel", parentSessionId: "s_root",
    ...(scenario === "legacy" ? {} : { campaignMembership: { campaignSessionId: "s_root", currentWorkItemId: "cwi_2", currentAttemptId: "catt_2" } }),
  });
  const unrelated = baseSession({ id: "s_other", title: "Unrelated Bug Fix" });
  return [root, child, unrelated];
}

/** `owners`: the child's merge, the Orchestrator's before #4064 and handed to the owner after it,
 * and after it the root's own owner decision. */
const mergeSnapshot = { category: "pr_merge" as const, repository: "picoduck/wollipog", pullRequest: 4141, headSha: "3f9c2e1".padEnd(40, "0"),
  reviewResult: "merge_with_acknowledged_risk" as const, requiredChecks: { headSha: "3f9c2e1".padEnd(40, "0"), status: "passed" as const, checkedAt: NOW - 9 * MINUTE,
    checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" as const }] } };
const ownerRequests = (owners: "before" | "after"): DescendantRequestView[] => {
  const handed = owners === "after";
  const evaluation = handed
    ? { owner: "human" as const, basis: "human_required" as const, reason: "owner_kept" as const, operation: "pr_merge" as const }
    : { owner: "orchestrator" as const, basis: "campaign_delegation" as const, reason: "authorized_operation" as const, operation: "pr_merge" as const };
  const merge: DescendantRequestView = {
    sessionId: "s_child_3", sessionTitle: "#2417 Slice 5: Read API", runnerId: "runner-1", runnerOnline: true, eventEpoch: 1,
    createdAt: NOW - 8 * MINUTE, responseOwner: evaluation.owner, authorityEvaluation: evaluation, occurrenceId: "occ_1",
    request: { requestId: "occ_1", occurrenceId: "occ_1", kind: "workflow_decision", title: "PR Merge Approval Required",
      options: [{ optionId: "approve", name: "Approve", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
      context: { toolName: "Typed Workflow Decision", input: JSON.stringify(mergeSnapshot, null, 2) },
      workflowDecision: { requestId: "merge-4141", occurrenceId: "occ_1", sessionId: "s_child_3", controllingSessionId: "s_root", category: "pr_merge",
        resourceKey: "picoduck/wollipog#4141", resourceSnapshot: mergeSnapshot, resourceDigest: "a".repeat(64), policyRevision: 1,
        authority: evaluation.owner, authorityEvaluation: evaluation, status: "pending", createdAt: NOW - 8 * MINUTE,
        ...(handed ? { ownerHandoff: { bySessionId: "s_root", at: NOW - 5 * MINUTE, reason: "The owner kept risk consent for this merge." } } : {}) } },
  };
  return ownerCard ? [{ sessionId: "s_root", sessionTitle: "Full Control Campaign", runnerId: "runner-1", runnerOnline: true, eventEpoch: 1,
    createdAt: NOW - 4 * MINUTE, responseOwner: "human", authorityEvaluation: ownerCard.workflowDecision!.authorityEvaluation,
    occurrenceId: "workflow_owner_1", request: ownerCard }, merge] : [merge];
};

/** The request the blocked item's recorded blocker names, pending on its child. */
const descendantRequests: DescendantRequestView[] = ownerScenario ? ownerRequests(ownerScenario) : scenario === "campaign" ? [{
  sessionId: "s_child_3",
  sessionTitle: "#2417 Slice 5: Read API",
  runnerId: "runner-1",
  runnerOnline: true,
  eventEpoch: 1,
  createdAt: NOW - 8 * MINUTE,
  responseOwner: "human",
  occurrenceId: "occ_1",
  request: {
    requestId: "req_1",
    ...(recoveryRecord ? { campaignRecovery: recoveryRecord } : {}),
    occurrenceId: "occ_1",
    title: "Run gh pr merge for the storage pull request",
    ...(recoveryRecord?.reason === "missing_access" ? {
      kind: "authentication" as const, title: "Sign in to the required provider account",
    } : {}),
    options: recoveryRecord?.reason === "missing_access" ? [
      { optionId: "auth:login", name: "Sign In", kind: "allow_once" },
      { optionId: "auth:dismiss", name: "Dismiss", kind: "reject_once" },
    ] : [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  },
}] : [];

const queries: string[] = [];
const forgeRefreshes: string[] = [];
let openedSession: string | null = null;
let selectedRequestKey: string | null = null;

const visibleItems = scenario === "planless" ? items.filter((item) => item.id === "cwi_2" || item.id === "cwi_3") : items;

// The same sentence and versions the control plane returns (campaign-issue-scope.ts).
const scopeRequirement = params.get("scope") === "outdated-runner" ? campaignIssueScopeChangesRequirement(207)
  : params.get("scope") === "issue-limits" ? campaignIssueLimitsRequirement(216) : null;
const scopeCompatibility = scopeRequirement ? (({ error, ...versions }) =>
  ({ supported: false, canPropose: false, compatibilityMessage: error, ...versions }))(scopeRequirement)
  : { supported: true, canPropose: true };

/** `screen=1`: the question screen's checks (#4104), one of them waiting for the owner to classify. */
const decisionUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
let screenDecisions: import("@wollipog/protocol").CampaignDecisionsResponse["decisions"] = params.get("screen") === "1" ? [
  { occurrenceId: "dec_keys", kind: "credential_screen", promptVersion: "credential_screen.v1", state: "decided", verdict: "discusses",
    reason: "It asks which keyboard keys the Side Panel tools should use; nothing is handed over.", inputDigests: {}, attempts: [],
    usage: decisionUsage, createdAt: NOW - 240_000, subject: { sessionId: "s_child", surface: "implementation_question", requestId: "keys" } },
  { occurrenceId: "dec_token", kind: "credential_screen", promptVersion: "credential_screen.v1", state: "decided", verdict: "ask",
    reason: "It asks whoever answers to paste a GitHub token.", inputDigests: {}, attempts: [],
    usage: decisionUsage, createdAt: NOW - 180_000, subject: { sessionId: "s_child", surface: "provider_question", requestId: "token" } },
  { occurrenceId: "dec_sessions", kind: "credential_screen", promptVersion: "credential_screen.v1", state: "failed", failureClass: "timed_out",
    inputDigests: {}, attempts: [], usage: decisionUsage, createdAt: NOW - 60_000,
    subject: { sessionId: "s_child", surface: "implementation_question", requestId: "sessions" } },
  ...(params.get("owner") === "1" ? [{ occurrenceId: "dec_owner", kind: "credential_screen" as const, promptVersion: "credential_screen.v1",
    state: "uncertain" as const, verdict: "uncertain", reason: "It may ask the owner to sign in to the provider.", inputDigests: {}, attempts: [],
    usage: decisionUsage, createdAt: NOW - 30_000, subject: { sessionId: "s_root", surface: "owner_decision" as const, requestId: "owner" } }] : []),
] : [];

const client = {
  ...api,
  campaignDecisions: async (id: string) => ({ campaignSessionId: id, decisions: screenDecisions,
    usage: { ...decisionUsage, calls: screenDecisions.length, unpricedCalls: 0 } }),
  classifyCampaignDecision: async (_id: string, occurrenceId: string, classification: "decline" | "orchestrator") => {
    (window as unknown as { __CLASSIFIED__: unknown }).__CLASSIFIED__ = { occurrenceId, classification };
    screenDecisions = screenDecisions.map((decision) => decision.occurrenceId === occurrenceId
      ? { ...decision, subject: { ...decision.subject!, classification } } : decision);
    return screenDecisions.find((decision) => decision.occurrenceId === occurrenceId)!.subject!;
  },
  campaignIssueScope: async (id: string) => params.get("scope") === "unsupported-target" ? api.campaignIssueScope(id)
    : ({ campaignSessionId: id, repository: "team/repo", issueNumbers: [], revision: 0,
    ...scopeCompatibility, outsideScope: [{ workItemId: "scope-fixture", title: "Member work", issue: { repository: "team/repo", number: 124 }, sessionId: "s_child" }],
    candidates: [{ issue: { repository: "team/repo", number: 123 }, title: "Composer Epic", source: "umbrella" as const },
      { issue: { repository: "team/repo", number: 124 }, title: "Member Work", source: "member_checklist" as const }],
    // A Full Control first message's derived scope and its context-only references (#3920).
    ...(params.get("scope") === "first-message" ? {
      issueNumbers: [123, 124, 125], revision: 2, outsideScope: [], candidates: [], contextIssueNumbers: [126, 127],
    } : {}),
    ...(params.get("completedChildren") === "1" && recoveryRecord?.reason === "failed_checks" ? {
      // Disclosed static scope data, not a live mint/approval or supported-profile assertion.
      issueNumbers: [123], revision: 1, canPropose: false, outsideScope: [], candidates: [],
    } : {}) }),
  setCampaignFollowUpLimit: async (_id: string, limit: number | null, expectedRevision: number) => {
    (window as unknown as { __FOLLOW_UP_LIMIT__: unknown }).__FOLLOW_UP_LIMIT__ = { limit, expectedRevision };
    return sessionsFor(revision)[0]!;
  },
  proposeCampaignIssueScope: async (_id: string, proposal: import("@wollipog/protocol").CampaignIssueScopeRequest) => {
    (window as unknown as { __SCOPE_PROPOSAL__: unknown }).__SCOPE_PROPOSAL__ = proposal;
    return { status: "pending" } as import("@wollipog/protocol").WorkflowDecisionView;
  },

  childSessions: () => Promise.reject(new ApiError("No registry in this fixture.", 404)),
  campaignWorkItems: async (_id: string, query: string) => {
    queries.push(query);
    if (params.get("refresh") === "failing" && queries.length > 1) {
      throw new ApiError("The control plane didn't answer in time.", 503);
    }
    const search = new URLSearchParams(query);
    const filters: CampaignWorkFilters = {
      origin: (search.get("origin") ?? "all") as CampaignWorkFilters["origin"],
      state: (search.get("state") ?? "unfinished") as CampaignWorkFilters["state"],
      sort: (search.get("sort") ?? "queue") as CampaignWorkFilters["sort"],
    };
    const matching = applyCampaignWorkFilters(visibleItems, filters, Date.now());
    const offset = Number(search.get("cursor") ?? 0);
    const limit = Number(search.get("limit") ?? 50);
    const page = matching.slice(offset, offset + limit);
    return {
      revision,
      items: page,
      total: matching.length,
      nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
    };
  },
  campaignWorkItem: async (_id: string, itemId: string) => {
    const item = details[itemId];
    if (!item) throw new ApiError("work item not found", 404);
    return { revision, item };
  },
  campaignForgeRefresh: async (id: string, itemId: string) => {
    forgeRefreshes.push(`${id}/${itemId}`);
    const item = details[itemId];
    if (!item) throw new ApiError("work item not found", 404);
    return { revision, pullRequests: item.observed.pullRequests ?? [] };
  },
} as ApiClient;

/** Feeds the store a snapshot, then lets the harness push later root updates. */
let pushToStore: ((message: ControlPlaneToUi) => void) | null = null;
class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    pushToStore = (message) => this.onmessage?.({ data: JSON.stringify(message) });
    window.setTimeout(() => {
      this.onopen?.();
      pushToStore?.({
        type: "snapshot",
        capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false },
        runners: [], boxes: [], projects: [], sessions: sessionsFor(revision), runs: [], pods: [],
      });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "campaign-status-e2e",
  runtimeKey: "campaign-status-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const initialSessionId = scenario === "member" ? "s_child" : scenario === "unrelated" ? "s_other" : "s_root";
const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: initialSessionId }),
  push() {},
  listen: () => () => {},
};

let navigateTo: ((sessionId: string) => void) | null = null;
let setRevision: ((value: number) => void) | null = null;

function Fixture() {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [rev, setRev] = useState(revision);
  navigateTo = setSessionId;
  setRevision = setRev;
  const session = sessionsFor(rev).find((candidate) => candidate.id === sessionId)!;
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<RightPanelMode>(params.get("open") === "launcher" ? "launcher" : params.get("open") === "requests" ? "requests" : "campaign");
  const [width, setWidth] = useState(420);
  const state: RightPanelState = {
    open, mode, width, dragging: false, subagentTarget: null,
    toggle: () => setOpen((value) => !value),
    openMode: (next) => { setMode(next); setOpen((value) => !(value && mode === next)); },
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
    <main className="app" style={{ display: "block", height: "100dvh" }}>
      <section className="session-detail expanded" style={{ height: "100%" }}>
        <header className="detail-bar session-bar">
          <h1 className="detail-bar-title session-bar-title">{session.title}</h1>
        </header>
        <div className="detail-columns">
          <div className="detail-chat">
            <div className="detail-main">
              <div className="detail-reader">
                <div className="detail-scroll" role="region" aria-label="Session Activity">
                  {Array.from({ length: 12 }, (_, index) => (
                    <div className={`tl-row ${index % 2 ? "agent" : "user"}`} key={index}>
                      <div className="tl-bubble">Transcript message {index + 1}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <PanelForSession state={state} session={session} onOpenSession={(id) => { openedSession = id; setSessionId(id); }} />
        </div>
      </section>
      {/* On a phone the app's tab bar fills the band below the panel sheet (--bottom-bar-h); this
          stand-in shows that band for what it is in the captures. */}
      {window.innerWidth <= 760 && (
        <nav aria-label="App Navigation" style={{
          position: "fixed", left: 0, right: 0, bottom: 0, height: "var(--bottom-bar-h)",
          display: "flex", alignItems: "center", justifyContent: "center",
          borderTop: "1px solid var(--border)", background: "var(--bg-elev)", color: "var(--text-dim)",
          font: "var(--type-small)",
        }}>
          App Tab Bar
        </nav>
      )}
    </main>
  );
}

function PanelForSession({ state, session, onOpenSession }: { state: RightPanelState; session: SessionView; onOpenSession: (id: string) => void }) {
  const availability = useCampaignStatusAvailability(session);
  const [requestKey, setRequestKey] = useState<string | null>(selectedRequestKey);
  return (
    <RightPanel
      state={state}
      session={session}
      runnerOnline
      runnerProtocolVersion={PROTOCOL_VERSION}
      onOpenSourceLocation={() => {}}
      onClearSourceLocation={() => {}}
      git={{
        status: null, observation: 0, observedAt: null, settled: true, busy: false, error: null, errorCode: null,
        refresh: async () => {}, refreshStatusOnly: async () => {}, install: () => {}, mutationRevision: 0,
      }}
      onOpenTerminal={() => {}}
      onInsertSideChatDraft={() => {}}
      items={[]}
      campaignAvailability={availability}
      onOpenSession={onOpenSession}
      descendantRequests={session.orchestratorCampaign ? descendantRequests : []}
      selectedRequestKey={requestKey}
      onSelectedRequestKeyChange={(key) => { selectedRequestKey = key; setRequestKey(key); }}
    />
  );
}

window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__ = {
  queries: () => [...queries],
  openedSession: () => openedSession,
  selectedRequestKey: () => selectedRequestKey,
  bumpRevision: () => {
    revision += 1;
    for (const session of sessionsFor(revision)) pushToStore?.({ type: "session_upsert", session });
    setRevision?.(revision);
  },
  navigate: (sessionId) => navigateTo?.(sessionId),
  forgeRefreshes: () => [...forgeRefreshes],
};

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <Fixture />
    </StoreProvider>
  </ApiProvider>,
);
