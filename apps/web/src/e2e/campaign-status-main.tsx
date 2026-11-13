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
 * `activity=active|cleanup|complete|stuck` shows each activity state (#4146), and `automation=` holds
 * its recovery automation (#3361).
 * `fullControl=rules|ready|old|degraded` makes it a Full Control campaign and shows its Full Control
 * section (#2940); see `fullControlProjection`.
 * With `budget=1`, `slots=held` lists two ended workers whose slots only the person can release, and
 * `slots=released` one of them released, with its record (#4331).
 * With `repositories=1`, `limited=1` reports the launch Location as limited by its runner (#4319).
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CAMPAIGN_AUTOMATION_HOLD_REASONS,
  CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
  CAMPAIGN_LIMITED_LOCATION_REASON,
  CAMPAIGN_WORK_ITEM_PRIMARY_STATES,
  campaignIssueLimitsRequirement,
  campaignIssueScopeChangesRequirement,
  pendingRequests,
  PROJECT_LOCATION_INSPECTION_FAILURES,
  PROTOCOL_VERSION,
  worktreeRefusalAction,
  type CampaignWorkItemDetail,
  type CampaignWorkItemHandoff,
  type CampaignWorkItemSummary,
  type ControlPlaneToUi,
  type DescendantRequestView,
  type ScopeProposalCheck,
  type SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { RightPanel, type RightPanelState } from "../components/RightPanel.js";
import { RequestDock, dockRequests } from "../components/requests/RequestDock.js";
import { useCampaignStatusAvailability } from "../components/useCampaignStatus.js";
import { applyCampaignWorkFilters, type CampaignWorkFilters } from "../campaign-status.js";
import type { RightPanelMode } from "../right-panel.js";
import { withPresentedOwnerQuestions } from "../owner-question-presentation.js";
import { StoreProvider } from "../store.js";
import type { ViewNavigation } from "../navigation.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { MINUTE, campaignProjection, forgeObservation, itemDetail, itemSummary, knownCost, workSummary } from "./campaign-status-fixtures.js";
import "../styles.css";
import { campaignRecoveryFixture } from "./campaign-recovery-fixtures.js";
import { epicTrackingFixture } from "./epic-tracking-fixture.js";
import {
  campaignDecisionsFixture,
  DECISION_TARGET,
  TYPED_ADMITTED,
  TYPED_CLOSURE_MISFIT,
  TYPED_REFUSED,
  TYPED_RELATED,
  TYPED_SCREEN_ASK,
  TYPED_SCREEN_DISCUSSES,
  TYPED_SCREEN_UNCERTAIN,
  TYPED_UNCERTAIN,
  TYPED_UNRELATED,
} from "./decision-model-fixtures.js";
import type { DecisionTypedAnswersView } from "@wollipog/protocol";

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

const NOW = params.has("closureRecovery") || params.has("epicTracking") ? Date.parse("2026-01-01T12:00:00Z") : Date.now();
let pauseFixture: import("@wollipog/protocol").CampaignPauseView | undefined = params.has("pause") ? {
  pausedAt: NOW - 10 * 60_000, pausedBy: "Sam Owner", resumeAt: params.get("pause") === "timed" ? NOW + 60 * 60_000 : null,
  stoppedSessionIds: ["s_child"], inFlightSessionIds: ["s_merge"],
  inFlightWork: [{ sessionId: "s_merge", description: "Merge of team/repo#4560 is still in flight; its merge watch is active." }],
  ...(params.get("pause") === "resumed" ? { resumedAt: NOW - 60_000, resumedBy: "Sam Owner" } : {}),
} : undefined;
const epicTracking = params.has("epicTracking") ? epicTrackingFixture(NOW,
  params.get("epicTracking") === "delivery" ? "delivery" : params.get("epicTracking") === "legacy" ? "legacy" : "complete") : null;
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

// `workRepositories=1` (#4120): work in two repositories. The settings change in picoduck/wollipog
// waits for the account field in picoduck/account-api, whose pull request is still in its queue.
const workRepositories = params.get("workRepositories") === "1";
if (workRepositories) {
  for (const item of items) item.repository = "picoduck/wollipog";
  Object.assign(items[3]!, {
    title: "Show Account Field in Settings", primaryState: "waiting", stateCauses: ["dependency_unmerged", "attempt_awaiting_verification"],
    mergeDependencies: [{ id: "cwi_10", key: "api:account-field", title: "Add Account Field", repository: "picoduck/account-api", status: "unmerged",
      pullRequests: [{ ref: { repository: "picoduck/account-api", number: 88 }, state: "open" }] }],
  } satisfies Partial<CampaignWorkItemSummary>);
  items.push(
    itemSummary("cwi_10", NOW, {
      title: "Add Account Field", key: "api:account-field", issue: { repository: "picoduck/account-api", number: 41 }, repository: "picoduck/account-api",
      queuePosition: 2, primaryState: "running", currentAttempt: { id: "catt_10", sessionId: "s_child_10", sessionTitle: "Account API: Add Account Field" },
      elapsed: { startedAt: NOW - 40 * MINUTE, endedAt: null }, cost: knownCost(1.85), activityAt: NOW - 2 * MINUTE,
      stage: { stage: "merge_queued", note: null, pullRequests: [{ repository: "picoduck/account-api", number: 88 }], sourceSessionId: "s_root", reportedAt: NOW - 5 * MINUTE },
    }),
    itemSummary("cwi_11", NOW, {
      title: "Document Account Field", key: "api:account-docs", issue: null, repository: "picoduck/account-api", queuePosition: 9,
      primaryState: "delivered", currentAttempt: null, attemptCount: 1, elapsed: { startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR },
      cost: knownCost(0.6), activityAt: NOW - HOUR,
    }),
  );
}

// `verifiedHolds=1` (#4120, with `workRepositories=1`): two items whose reports were verified while
// their own pull requests are still open. One waits for its prerequisite's merge; the other's
// prerequisite closed without merging, so it is blocked and never merged.
if (workRepositories && params.get("verifiedHolds") === "1") {
  const verified = { currentAttempt: null, attemptCount: 1, elapsed: { startedAt: NOW - 3 * HOUR, endedAt: null }, cost: knownCost(0.9), activityAt: NOW - 30 * MINUTE };
  items.push(
    itemSummary("cwi_12", NOW, {
      ...verified, title: "Show Account Badge", key: "app:account-badge", issue: { repository: "picoduck/wollipog", number: 4120 }, repository: "picoduck/wollipog",
      queuePosition: 10, primaryState: "waiting", stateCauses: ["dependency_unmerged"],
      stage: { stage: "in_review", note: null, pullRequests: [{ repository: "picoduck/wollipog", number: 4400 }], sourceSessionId: "s_root", reportedAt: NOW - 30 * MINUTE },
      mergeDependencies: [{ id: "cwi_10", key: "api:account-field", title: "Add Account Field", repository: "picoduck/account-api", status: "unmerged",
        pullRequests: [{ ref: { repository: "picoduck/account-api", number: 88 }, state: "open" }] }],
    }),
    itemSummary("cwi_13", NOW, {
      ...verified, title: "Show Account Avatar", key: "app:account-avatar", issue: { repository: "picoduck/wollipog", number: 4121 }, repository: "picoduck/wollipog",
      queuePosition: 11, primaryState: "blocked", stateCauses: ["dependency_blocked"],
      stage: { stage: "in_review", note: null, pullRequests: [{ repository: "picoduck/wollipog", number: 4401 }], sourceSessionId: "s_root", reportedAt: NOW - 30 * MINUTE },
      mergeDependencies: [{ id: "cwi_14", key: "api:avatar-field", title: "Add Avatar Field", repository: "picoduck/account-api", status: "failed",
        pullRequests: [{ ref: { repository: "picoduck/account-api", number: 87 }, state: "closed" }] }],
    }),
  );
}

/** The control plane's per-repository counts over every recorded item (#4120). */
function fixtureRepositoryCounts(all: readonly CampaignWorkItemSummary[]) {
  const counts = new Map<string | null, { repository: string | null; total: number; byState: Record<string, number> }>();
  for (const item of all) {
    const repository = item.repository ?? null;
    const entry = counts.get(repository) ?? { repository, total: 0, byState: Object.fromEntries(CAMPAIGN_WORK_ITEM_PRIMARY_STATES.map((state) => [state, 0])) };
    entry.byState[item.primaryState] = (entry.byState[item.primaryState] ?? 0) + 1;
    entry.total += 1;
    counts.set(repository, entry);
  }
  return [...counts.values()] as import("@wollipog/protocol").CampaignWorkRepositoryCounts[];
}

const details: Record<string, CampaignWorkItemDetail> = Object.fromEntries(items.map((item) => [item.id, itemDetail(item)]));
if (workRepositories) {
  details.cwi_4 = itemDetail(items[3]!, {
    dependsOn: [{ id: "cwi_10", key: "api:account-field", title: "Add Account Field", primaryState: "running" }],
    nextAction: "Merge once picoduck/account-api#88 lands.",
  });
}
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

const ROOT_TITLE = epicTracking ? "#4403 Epic Tracking Campaign" : params.has("closureRecovery") ? "#4398 Closure Recovery Campaign" : "#2417 Campaign Orchestrator";
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
    title: ROOT_TITLE, status: epicTracking ? "idle" : "running", adopted: false, eventEpoch: 1, archived: false, runId: null,
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

/** `fullControl=rules|ready|old|degraded` (#2940): a Full Control campaign's boundary and what its launch
 * disclosed, as Campaign Status shows it after launch. `rules`: a person-marked Human Required rule and
 * a long objective; `ready`: nothing comes to the person; `old`: authorized before the launch record
 * existed; `degraded`: an Orchestrator that can't view images. Static rendering data only. */
const fullControlScenario = ["rules", "ready", "old", "degraded"].includes(params.get("fullControl") ?? "")
  ? params.get("fullControl") as "rules" | "ready" | "old" | "degraded" : null;
const FULL_CONTROL_OPERATIONS = ["implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication",
  "ui_evidence_approval", "issue_closure", "campaign_issue_scope", "question", "tool_approval", "policy_ask"] as const;
function fullControlProjection(kind: "rules" | "ready" | "old" | "degraded"): Partial<import("@wollipog/protocol").OrchestratorCampaignProjection> {
  const objective = kind === "rules"
    ? "Fix Full Control authority, gate routing and admission in picoduck/wollipog: #4137, #3676, #3685, #3618, #3382 and #3237. " +
      "Each issue specifies its behavior and acceptance criteria; follow them and say so in each pull request. Close an issue only after " +
      "verifying every criterion against merged main, and deliver an issue in slices when one pull request can't meet all of its criteria."
    : "Deliver picoduck/wollipog #4137 and #3676.";
  const images = kind === "degraded" ? "orchestrator_decides" as const : "verified" as const;
  return {
    control: { mode: "full_control", boundary: { version: 1, revision: 4, issueScopeRevision: 3, repository: "picoduck/wollipog", objective,
      authorizedByUserId: "fixture-human", authorizedAt: NOW - 3 * 60 * MINUTE, operations: [...FULL_CONTROL_OPERATIONS], delegatablePolicyIds: [],
      issueAuthority: { epics: [2940], relatedFollowUps: true, maxIssues: 21, closureReasons: ["completed"] },
      budgetAuthority: { version: 1, concurrency: 3, acceptedFollowUps: 20, accounting: "managed_workers_only", unpriced: "stop" } } },
    decisionOwners: { implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
      follow_up_issue_publication: "orchestrator", ui_evidence_approval: "orchestrator", review_round_extension: "orchestrator" },
    fullControlHumanRequired: kind === "rules" ? ["human_required_rules"] : [],
    // Nothing waits in recovery unless `recovery=` adds a record (its own fixture wins below).
    ...(recoveryRecord ? {} : { recovery: { unattendedReady: true, automation: { state: "available" as const }, automatic: 0,
      waitingHuman: 0, blocked: 0, records: [], truncated: false } }),
    uiEvidenceReview: kind === "degraded"
      ? { status: "unavailable", effectiveOwner: "orchestrator", reasonCode: "model_unsupported",
        reason: "The Orchestrator model \"text-only\" does not accept image input. It asks for inspectable evidence or denies the claim as unproven." }
      : { status: "available", effectiveOwner: "orchestrator" },
    videoEvidenceReview: { status: "unavailable",
      reason: "The Orchestrator can't watch video because no current live proof certifies the media-only reviewer on the Orchestrator's machine. It asks for screenshots or denies the claim as unproven." },
    ...(params.get("scope") === "grant" ? { maxIssuesSource: "derived" as const } : {}),
    ...(kind === "old" ? {} : { launchDisclosure: {
      version: 1, source: kind === "degraded" ? "enable" : "launch", recordedAt: NOW - 3 * 60 * MINUTE,
      capabilities: [
        { id: "repository_scope", capability: "Repository and Issue Scope", state: "verified",
          reason: "The registered workspace's origin is picoduck/wollipog and issues #4137, #3676 were read from it.", mandatory: true },
        { id: "authority_contract", capability: "Full Control Authority", state: "verified", reason: "The claude-code root's runner enforces the Full Control authority contract.", mandatory: true },
        { id: "accounting_budget", capability: "Campaign Accounting and Budget", state: "verified",
          reason: "No limit. Managed workers are metered and priced, and Campaign Status shows the campaign's usage.", mandatory: false },
        { id: "native_review", capability: "Controlled Cross-Model Review", state: "informational",
          reason: "This runner does not offer the controlled reviewer, which needs provider isolation (current: unreported), Claude Code CLI 2.1.296 and python3 on Linux; the campaign uses the regular cross-model review workflow.", mandatory: false },
        { id: "execution_isolation", capability: "Execution Isolation", state: "informational", reason: "The runner does not report the execution isolation it enforces.", mandatory: false },
        { id: "image_evidence", capability: "Screenshot Evidence Review", state: images, reason: images === "verified"
          ? "Screenshots attached as private Session artifacts are reviewed by the Orchestrator."
          : "The Orchestrator can't view screenshots: its model doesn't accept image input. It asks for inspectable evidence or denies the claim as unproven.", mandatory: false },
        { id: "video_evidence", capability: "Video Evidence Review", state: "orchestrator_decides",
          reason: "The Orchestrator can't watch video, so it asks for screenshots or denies the claim as unproven.", mandatory: false },
        { id: "external_evidence", capability: "Externally Stored Evidence", state: "orchestrator_decides",
          reason: "The Orchestrator can't inspect externally stored evidence, so it asks for Session artifacts or denies the claim as unproven.", mandatory: false },
      ],
      evidence: {
        statement: images === "verified"
          ? "The Orchestrator reviews screenshots. For video and external evidence it asks for screenshots or denies the claim as unproven."
          : "The Orchestrator decides UI evidence but can't view images, so it asks for inspectable evidence or denies the claim as unproven.",
        destination: "private_session_artifacts",
        provider: images === "verified" ? { providerId: "claude-code", disclosureRevision: 1, retentionDisclosure: CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
          reviewer: { driver: "claude-code", model: "claude-opus-5-5" } } : null,
      },
    } }),
  };
}

/** `activity=active|cleanup|complete|stuck` (#4146): the same delivered-or-idle campaign in each
 * activity state, as a v297 control plane reports it; `legacy=1` is what an older one reported for
 * the same facts (Active for owed cleanup, Blocked for stuck work, and no lists). */
const activityScenario = (["active", "cleanup", "complete", "stuck"] as const).find((value) => params.get("activity") === value) ?? null;
const activityLegacy = params.get("legacy") === "1";
/** `automation=complete|held|unsupported` (#3361) holds the recovery automation with the server's
 * reason for a campaign with nothing left to recover (as servers before #4070 sent it on a finished
 * campaign too), for original work no recovery can continue, or for an unsupported provider. */
const automationHold = params.get("automation") === "complete"
  ? { state: "lifecycle_held" as const, reason: CAMPAIGN_AUTOMATION_HOLD_REASONS.complete }
  : params.get("automation") === "held" ? { state: "lifecycle_held" as const, reason: CAMPAIGN_AUTOMATION_HOLD_REASONS.recoveryHeld }
  : params.get("automation") === "unsupported"
    ? { state: "unsupported_capability" as const, reason: "The current provider cannot enforce authorized recovery." } : null;
// Each state's work matches its facts: delivered states have every committed item delivered; Active
// keeps the Campaign Status Panel item running in its child, its PR waiting in the merge queue.
if (activityScenario === "active" || activityScenario === "cleanup" || activityScenario === "complete") {
  for (const [index, item] of items.entries()) {
    if (item.commitment !== "committed") continue;
    const live = activityScenario === "active" && item.id === "cwi_2";
    items[index] = live ? { ...item, primaryState: "running", stateCauses: [], blocker: null }
      : { ...item, primaryState: "delivered", stateCauses: [], currentAttempt: null, blocker: null,
        elapsed: { startedAt: item.elapsed.startedAt ?? NOW - 2 * HOUR, endedAt: item.elapsed.endedAt ?? NOW - 20 * MINUTE } };
    details[item.id] = itemDetail(items[index]!);
  }
}
const activityWork = (rev: number) => {
  const committed = items.filter((item) => item.commitment === "committed");
  const delivered = committed.filter((item) => item.primaryState === "delivered").length;
  const running = committed.filter((item) => item.primaryState === "running").length;
  return { ...recordedWork(rev),
    counts: { committed: committed.length, delivered, original: committed.filter((item) => item.origin === "original").length,
      followUp: committed.filter((item) => item.origin !== "original").length, cancelled: 0,
      removed: items.filter((item) => item.commitment !== "committed").length,
      byState: { planned: 0, queued: 0, running, waiting: 0, blocked: 0, delivered, cancelled: 0,
        removed: items.filter((item) => item.commitment !== "committed").length } },
    recommendations: { awaiting_adjudication: 0, accepted: 2, rejected: 1, deferred: 1, duplicate: 3 },
    obligations: { verification: 0, adjudication: 0, publication: 0, cleanup: 0 },
    elapsed: { startedAt: NOW - 3 * HOUR - 12 * MINUTE, endedAt: activityScenario === "active" ? null : NOW - 8 * MINUTE },
  };
};
function activityProjection(state: "active" | "cleanup" | "complete" | "stuck"): Partial<import("@wollipog/protocol").OrchestratorCampaignProjection> {
  const status = state === "active" ? "active" : state === "cleanup" ? (activityLegacy ? "active" : "complete_needs_cleanup")
    : state === "complete" ? "verified_complete" : activityLegacy ? "blocked" : "stuck";
  const repair = { state: "attempted" as const, startedAt: NOW - 9 * MINUTE, finishedAt: NOW - 8 * MINUTE, continuation: true };
  const worktreeReason = params.get("retirement") === "ownership" ? "runner ownership could not be proven"
    : params.get("retirement") === "1" ? "the branch has no upstream"
      : "the worktree has uncommitted changes (2 paths): \"report.md\", \"notes.txt\"";
  return {
    status: status as import("@wollipog/protocol").OrchestratorCampaignStatus,
    children: state === "stuck"
      ? { total: 3, active: 0, waitingHuman: 0, blocked: 0, verified: 2, cleanupPending: 0 }
      : state === "active" ? { total: 3, active: 1, waitingHuman: 0, blocked: 0, verified: 2, cleanupPending: 0 }
      : { total: 3, active: 0, waitingHuman: 0, blocked: 0, verified: 3, cleanupPending: 0 },
    limits: { maximumConcurrentChildren: 4, occupied: state === "active" ? 1 : 0, remaining: state === "active" ? 3 : 4, costBudgetUsd: 40, maxToolCalls: null },
    heldChildren: [],
    ...(activityLegacy ? {} : { activity: state === "active" ? { live: ["child_turn" as const, "merge_queue_wait" as const] } : { live: [], ...(state === "complete" ? {} : { repair }) } }),
    ...(state === "cleanup" && !activityLegacy ? { cleanup: { total: 3, items: [
      { kind: "merged_branch" as const, sessionId: "s_child", repository: "picoduck/wollipog", pullRequest: 4217, branch: "agent/s_9d2f41c07a11",
        state: "pending" as const, reason: "The merged branch is still on the remote.",
        action: { kind: "command" as const, command: "gh api -X DELETE 'repos/picoduck/wollipog/git/refs/heads/agent/s_9d2f41c07a11'" } },
      { kind: "merged_branch" as const, sessionId: "s_child", repository: "picoduck/wollipog", pullRequest: 4223, branch: "agent/s_b845cb95d6be",
        state: "pending" as const, reason: "The last deletion was refused: The forge could not be reached.",
        action: { kind: "delete_merged_branches" as const, occurrenceId: "workflow_delete_4223" } },
      { kind: "worktree" as const, sessionId: "s_child", path: "/home/dev/worktrees/wollipog/s_079714ea231c", status: "refused" as const,
        // The reason and action come from the protocol, as the control plane derives them.
        reason: worktreeReason.charAt(0).toUpperCase() + worktreeReason.slice(1) + ".",
        action: worktreeRefusalAction(worktreeReason) },
    ] } } : {}),
    ...(state === "stuck" && !activityLegacy ? { stuck: { total: 2, items: [
      { kind: "unverified_child" as const, sessionId: "s_child", status: "idle", reason: "The child's latest report has not been verified." },
      { kind: "orchestrator_request" as const, sessionId: "s_child", occurrenceId: "workflow_merge_4234",
        reason: "An Orchestrator-owned decision is waiting for the Orchestrator." },
    ] } } : {}),
  };
}

let revision = 1;
/** Whether the owner included the waiting Location (`repositories=1`). */
let included = false;
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
      : activityScenario && activityScenario !== "stuck" ? activityWork(rev)
      : handoffScenario || activityScenario ? handoffWork(rev) : recordedWork(rev),
  {
    limits: { maximumConcurrentChildren: 4, occupied: 3, remaining: 1, costBudgetUsd: 40, maxToolCalls: null },
    ...(pauseFixture ? { status: pauseFixture.resumedAt === undefined ? "paused" as const : "active" as const, pause: pauseFixture } : {}),
    // `repositories=1`: a multi-repository boundary with an exclusion, a removed Location and a
    // Location someone else added (#4117). Static rendering data only.
    ...(params.get("repositories") === "1" ? { repositoryBoundary: {
      revision: included ? 7 : 6,
      repositories: [
        { repository: "picoduck/wollipog", locations: [
          { locationId: "loc_laptop", name: "Wollipog on Laptop", availability: "available" as const, isDefault: true },
          { locationId: "loc_desk", name: "Wollipog on Desk", availability: "runner_offline" as const, isDefault: false },
        ] },
        { repository: "picoduck/dev-box-setup", locations: [
          { locationId: "loc_setup", name: "Dev Box Setup", availability: "available" as const, isDefault: false },
        ] },
        { repository: "picoduck/notes-site", locations: [
          { locationId: "loc_site", name: "Notes Site", availability: "removed" as const, isDefault: false },
        ] },
        ...(included ? [{ repository: "picoduck/shared-docs", locations: [
          { locationId: "loc_shared", name: "Shared Docs", availability: "available" as const, isDefault: false }] }] : []),
      ],
      excludedLocations: [
        { locationId: "loc_scratch", name: "Scratch Folder", failure: "not_repository" as const,
          reason: "The Location's folder is not a git repository with a valid HEAD." },
        { locationId: "loc_old", name: "Wollipog on Old Mac", failure: "runner_below_gates" as const,
          reason: PROJECT_LOCATION_INSPECTION_FAILURES.runner_below_gates, repository: "picoduck/old-tools" },
        { locationId: "loc_away", name: "Wollipog on Travel Laptop", failure: "runner_offline" as const,
          reason: "The Location's machine is offline." },
      ],
      ...(params.get("limited") === "1" ? { limitedLocations: [{ locationId: "loc_laptop", name: "Wollipog on Laptop", reason: CAMPAIGN_LIMITED_LOCATION_REASON }] } : {}),
      // `waiting=causes`: one waiting Location for each recorded cause, and one stored before causes were (#4312).
      pendingLocations: included ? [] : params.get("waiting") === "causes" ? [
        { locationId: "loc_shared", name: "Shared Docs", reason: "added_by_other" as const, cause: "added_by_other" as const },
        { locationId: "loc_unrecorded", name: "Old Scripts Folder", reason: "added_by_other" as const, cause: "no_recorded_adder" as const },
        { locationId: "loc_second", name: "Wollipog Second Checkout", reason: "added_by_other" as const, cause: "repository_added" as const },
        { locationId: "loc_stored", name: "Archive Checkout", reason: "added_by_other" as const },
      ] : [{ locationId: "loc_shared", name: "Shared Docs", reason: "added_by_other" as const }],
      joins: [
        { locationId: "loc_setup", name: "Dev Box Setup", repository: "picoduck/dev-box-setup", revision: 6, at: NOW - 60_000, source: "owner_added" as const },
        ...(included ? [{ locationId: "loc_shared", name: "Shared Docs", repository: "picoduck/shared-docs", revision: 7, at: NOW, source: "owner_included" as const }] : []),
      ],
    } } : {}),
    // `repositories=limited`: the owner's first message limited the campaign to two of its Project's
    // repositories, so another's Locations are available but don't join (#4117).
    ...(params.get("repositories") === "limited" ? { repositoryBoundary: {
      revision: 7,
      repositories: [
        { repository: "picoduck/wollipog", locations: [
          { locationId: "loc_laptop", name: "Wollipog on Laptop", availability: "available" as const, isDefault: true }] },
        { repository: "picoduck/dev-box-setup", locations: [
          { locationId: "loc_setup", name: "Dev Box Setup", availability: "available" as const, isDefault: false }] },
      ],
      excludedLocations: [],
      pendingLocations: [],
      availableLocations: [
        { locationId: "loc_docs", name: "Shared Docs", repository: "picoduck/shared-docs" },
        { locationId: "loc_docs_desk", name: "Shared Docs on Desk", repository: "picoduck/shared-docs" },
      ],
      repositoryLimits: ["picoduck/wollipog", "picoduck/dev-box-setup"],
      joins: [],
    } } : {}),
    // `repositories=custom`: a Custom campaign's list, extended by an approved repository addition;
    // it has no authority boundary, so no revision (#4117).
    ...(params.get("repositories") === "custom" ? { repositoryBoundary: {
      revision: 0,
      repositories: [
        { repository: "picoduck/wollipog", locations: [
          { locationId: "loc_laptop", name: "Wollipog on Laptop", availability: "available" as const, isDefault: true }] },
        { repository: "picoduck/shared-docs", locations: [
          { locationId: "loc_shared", name: "Shared Docs", availability: "available" as const, isDefault: false }] },
      ],
      excludedLocations: [],
      pendingLocations: [],
      joins: [{ locationId: "loc_shared", name: "Shared Docs", repository: "picoduck/shared-docs", revision: 0, at: NOW, source: "addition_approved" as const }],
    } } : {}),
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
      // `slots=held`: two ended workers whose slots only the person can release; `slots=released`: one released (#4331).
      ...(params.get("slots") === "held" ? { heldSlots: [
        { sessionId: "s_child_3", title: "#2417 Slice 5: Read API", generation: "gen_3", reason: "older_runner" as const, status: "failed" as const },
        { sessionId: "s_child_4", title: "#2417 Slice 6: Time and Cost", generation: "gen_4", reason: "unsupported_location" as const, status: "stopped" as const },
      ] } : {}),
      ...(params.get("slots") === "released" ? { heldSlots: [
        { sessionId: "s_child_4", title: "#2417 Slice 6: Time and Cost", generation: "gen_4", reason: "unsupported_location" as const, status: "stopped" as const },
      ], slotReleases: [{ sessionId: "s_child_3", title: "#2417 Slice 5: Read API", generation: "gen_3", releasedByUserId: "usr_owner",
        releasedByName: "Sam Owner", releasedAt: NOW - 4 * MINUTE, reason: "Rebooted the build machine; no provider process remains",
        heldReason: "older_runner" as const, settlement: { costUsd: 2.05, toolCalls: 41, source: "checkpoint" as const } }] } : {}),
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
    ...(activityScenario ? activityProjection(activityScenario) : {}),
    ...(automationHold ? { recovery: { unattendedReady: false, automation: automationHold, automatic: 0, waitingHuman: 0, blocked: 0,
      records: [], truncated: false } } : {}),
    ...ownerProjection,
    ...ownerScopeProjection(rev),
    // `ownerAddition=1` (#4117): the Orchestrator's request to add a repository waits for the owner.
    ...(params.get("ownerAddition") === "1" ? { status: "waiting_human" as const, ownerDecisions: { total: 1, items: [
      { occurrenceId: "wd_addition_1", sessionId: "s_root", category: "campaign_repository_addition" as const,
        summary: "Add picoduck/notes-site to the campaign", handedOff: false, createdAt: NOW - 2 * 60_000 },
    ] } } : {}),
    ...(fullControlScenario ? fullControlProjection(fullControlScenario) : {}),
    ...(epicTracking?.projection(rev) ?? {}),
    ...(params.has("closureRecovery") ? {
      status: params.get("closureRecovery") === "settled" ? "verified_complete" as const : "waiting_human" as const,
      limits: { maximumConcurrentChildren: 3, occupied: 0, remaining: 3, costBudgetUsd: null, maxToolCalls: null },
      children: { total: 1, active: 0, waitingHuman: 0, blocked: 0, verified: 1, cleanupPending: 0 },
      heldChildren: [], followUps: { unique: 0, duplicates: 0 },
      pendingDecisions: { human: params.get("closureRecovery") === "settled" ? 0 : 1, orchestrator: 0 },
      work: workSummary(NOW, { revision: rev, counts: { committed: 1, delivered: 1, original: 1, followUp: 0, cancelled: 0, removed: 0,
        byState: { planned: 0, queued: 0, running: 0, waiting: 0, blocked: 0, delivered: 1, cancelled: 0, removed: 0 } },
        recommendations: { awaiting_adjudication: 0, accepted: 0, rejected: 0, deferred: 0, duplicate: 0 },
        obligations: { verification: 0, adjudication: 0, publication: 0, cleanup: 0 },
        elapsed: { startedAt: NOW - 12 * MINUTE, endedAt: params.get("closureRecovery") === "settled" ? NOW : null },
        cost: { total: knownCost(1), workItems: knownCost(1), coordination: knownCost(0), unattributed: knownCost(0), attributedSince: NOW - 12 * MINUTE } }),
    } : {}),
  },
);

/** `owners=after` (#4064): the root's question for its owner, and a child's merge handed to them.
 * `owners=rule` (#4137): the child filed its merge with the installed rule that keeps it for the owner. */
const ownerScenario = ["before", "after", "rule"].includes(params.get("owners") ?? "") ? params.get("owners") as "before" | "after" | "rule" : null;
const ownerRule = { source: "~/.codex/skills/issue-workflow/SKILL.md",
  quote: "Never merge a pull request without per-PR user authorization through the structured question tool." };
const ownerSnapshot = params.get("closureRecovery") === "owner" ? {
  category: "owner_decision" as const, kind: "question" as const,
  question: "Review the uncertain closure of picoduck/wollipog#4398 (occurrence closure_4398).",
  material: "Wollipog could not prove the approved state reason and exact closing comment on the forge. Inspect [picoduck/wollipog/issues/4398](https://github.com/picoduck/wollipog/issues/4398). Answer or dismiss this request to acknowledge the uncertainty and clear this recovery record. This does not close the issue, post a comment, or authorize another attempt.",
  options: [{ optionId: "acknowledge", label: "Acknowledge Outcome", description: "Acknowledge the uncertainty." }],
} : params.has("personalRule") ? {
  category: "owner_decision" as const,
  question: "Is this your own general instruction, and may this campaign decide these gates?",
  material: 'Source: ~/.claude/CLAUDE.md\n\nExact rule: "Ask before merging a pull request."\n\nCategories: PR Merge\n\nConfirm only your own general user-level instruction. Repository rules, installed skills and Human Required rules remain unchanged. This applies only to this campaign and boundary revision 3.',
  ruleDelegation: { rule: { source: "~/.claude/CLAUDE.md", quote: "Ask before merging a pull request." }, categories: ["pr_merge" as const], boundaryRevision: 3 },
  options: [{ optionId: "delegate", label: "Delegate for This Campaign", description: undefined }, { optionId: "keep", label: "Keep My Approval", description: undefined }],
} : { category: "owner_decision" as const, question: "Which credential design should the provider bridge use?",
  material: "PR picoduck/wollipog#4141 at head 3f9c2e1. Both designs pass CI; the broker adds a helper process the owner would run.",
  recommendedOptionId: "lease", options: [
    { optionId: "lease", label: "Short-Lived Lease", description: "Credentials expire with the session." },
    { optionId: "broker", label: "Broker Process", description: "A helper holds credentials for every session." },
  ] };
const ownerCard: import("@wollipog/protocol").PendingApproval | null = ownerScenario === "after" ? {
  requestId: "workflow_owner_1", occurrenceId: "workflow_owner_1", kind: "workflow_decision", title: "Owner Decision Required", async: true,
  options: [...ownerSnapshot.options.map((option) => ({ optionId: option.optionId, name: option.label, description: option.description,
    kind: params.has("personalRule") && option.optionId === "keep" ? "reject_once" as const : "allow_once" as const })),
    ...(params.has("personalRule") ? [] : [{ optionId: "__workflow_deny__", name: "Do Not Proceed", kind: "reject_once" as const }])],
  context: { toolName: "Typed Workflow Decision", input: JSON.stringify(ownerSnapshot, null, 2) },
  workflowDecision: { requestId: "credential-design", occurrenceId: "workflow_owner_1", sessionId: "s_root", controllingSessionId: "s_root",
    category: "owner_decision", resourceKey: "credential-design", resourceSnapshot: ownerSnapshot, resourceDigest: "e".repeat(64), policyRevision: 1,
    authority: "human", authorityEvaluation: { owner: "human", basis: "human_required", reason: "owner_kept", operation: "owner_decision" },
    status: "pending", createdAt: NOW - 4 * MINUTE },
} : null;
const ownerProjection = ownerScenario === "after" ? { status: "waiting_human" as const, ownerDecisions: { total: params.has("closureRecovery") ? 1 : 2, items: [
  { occurrenceId: "workflow_owner_1", sessionId: "s_root", category: "owner_decision" as const, summary: ownerSnapshot.question, handedOff: false, createdAt: NOW - 4 * MINUTE },
  ...(params.has("closureRecovery") ? [] : [{ occurrenceId: "occ_1", sessionId: "s_child_3", category: "pr_merge" as const, summary: "Merge picoduck/wollipog#4141", handedOff: true, createdAt: NOW - 8 * MINUTE }]),
] } } : ownerScenario === "rule" ? { status: "waiting_human" as const, ownerDecisions: { total: 1, items: [
  { occurrenceId: "occ_1", sessionId: "s_child_3", category: "pr_merge" as const, summary: "Merge picoduck/wollipog#4141", handedOff: false,
    ownerRule, createdAt: NOW - 8 * MINUTE },
] } } : {};

/** `ownerScope` (#4267, #4334): scope approvals the server routed to the owner. `1` is the
 * Orchestrator's proposal without lineage with the Maximum Issues increase its additions need, `grant`
 * a failed grant's across two repositories, `proposal` a proposal check's owner route, and `routed` all
 * three, so opening one shows it is that one. A revision bump settles them all. */
const ownerScopeBase = { category: "campaign_issue_scope" as const, repository: "team/repo", expectedRevision: 0,
  before: [], removals: [], affectedAssignments: [], affectedDecisions: ["occ_1"], activeChildren: [] };
const lineageIncrease = new URLSearchParams(window.location.search).get("lineageIncrease") === "1";
const ownerScopeRoutes = {
  owner: { occurrenceId: "wd_scope_141", summary: new URLSearchParams(window.location.search).get("lineageReview") === "1"
    ? lineageIncrease
      ? "Add team/repo#141, team/repo#142, raising Maximum Issues from 6 to 7. The named epic is outside the authorized epics, so it needs your approval. (epic_not_authorized)"
      : "Add team/repo#141. The publication's authority differs from the current boundary, so it needs your approval. (publication_authority_changed)"
    : "Add team/repo#141, team/repo#142, raising Maximum Issues from 6 to 7", snapshot: { ...ownerScopeBase,
    ...(new URLSearchParams(window.location.search).get("lineageReview") === "1" ? {
      ...(lineageIncrease ? {
        before: [130, 131, 132, 133, 134], additions: [141, 142],
        explanation: "Add two members of another epic through owner scope approval.",
        lineage: { kind: "epic" as const, epic: 140 },
        ownerReview: { cause: "epic_not_authorized" as const, maxIssuesIncrease: { from: 6, increase: 1 } },
      } : {
        additions: [141],
        explanation: "Adopt the verified published follow-up under the current campaign boundary.",
        lineage: { kind: "follow_up" as const, publicationOccurrenceId: "published-repair" },
        verifiedPublications: [{ publicationOccurrenceId: "published-repair", issue: 141 }],
        ownerReview: { cause: "publication_authority_changed" as const },
      }),
    } : { additions: [141, 142],
      explanation: "You asked me to start #141 and #142 after launch. Neither is an epic member or a published follow-up.",
      ownerReview: { cause: "lineage_missing" as const, maxIssuesIncrease: { from: 6, increase: 1 } } }) } },
  grant: { occurrenceId: "wd_scope_143", summary: "Add team/repo#143, team/docs#7, raising Maximum Issues from 6 to 9", derivedIncrease: { from: 6, increase: 3 }, snapshot: { ...ownerScopeBase, additions: [143],
    otherRepositories: [{ repository: "team/docs", before: [], additions: [7], removals: [] }],
    explanation: "Reading your first message failed, so I chose the two issues it seems to mean.",
    grantReview: { cause: "grant_failed" as const, ownerMessage: "Fix the worst bugs in the app and its docs", messageDigest: "a".repeat(64),
      grantOccurrenceId: "dec_grant_143", failureClass: "provider_overloaded" as const } } },
  proposal: { occurrenceId: "wd_scope_151", summary: "Add team/repo#151, team/repo#152, raising Maximum Issues from 6 to 8", derivedIncrease: { from: 6, increase: 2 }, snapshot: { ...ownerScopeBase, additions: [151, 152],
    explanation: "Both are open UI bugs. I ranked them by priority label, then by age.",
    scopeProposal: { initial: false, messageDigest: "a".repeat(64), requestedCount: 2, constraints: ["open", "UI only"], withheldOperations: [],
      checks: ["chosen_issues", "requested_count", "constraints"] as ScopeProposalCheck[], route: "owner" as const, ownerCause: "constraint_check_failed" as const,
      constraintCheck: { occurrenceId: "dec_scope_151", verdict: "failed" as const, failureClass: "provider_overloaded" as const },
      ownerMessage: "Fix the two most important open UI bugs.",
      issues: [
        { number: 151, origin: "orchestrator_chosen" as const, rationale: "Open UI bug, priority:high, oldest.", title: "Sidebar Collapses on Resize" },
        { number: 152, origin: "orchestrator_chosen" as const, rationale: "Open UI bug, priority:high.", title: "Badge Contrast in Light Theme" },
      ] } } },
};
const ownerScopeParam = params.get("ownerScope");
const allScope = { ...ownerScopeRoutes.proposal,
  summary: "Add team/repo#151, team/repo#152, raising Maximum Issues from 1 to 2",
  derivedIncrease: { from: 1, increase: 1 },
  snapshot: {
  ...ownerScopeRoutes.proposal.snapshot,
  before: [],
  ownerReview: { cause: "lineage_missing" as const, maxIssuesIncrease: { from: 1, increase: 1 } },
  scopeProposal: { ...ownerScopeRoutes.proposal.snapshot.scopeProposal,
    requestedCount: "all" as const, ownerCause: "issue_ceiling_exceeded" as const,
    ownerMessage: "Fix all open UI issues.",
    constraintCheck: { occurrenceId: "dec_scope_151", verdict: "admit" as const },
  },
} };
const ownerScopeChosen: Array<{ occurrenceId: string; summary: string; derivedIncrease?: { from: number; increase: number };
  snapshot: import("@wollipog/protocol").CampaignIssueScopeSnapshot }> = ownerScopeParam === "1" ? [ownerScopeRoutes.owner] : ownerScopeParam === "grant" ? [ownerScopeRoutes.grant]
  : ownerScopeParam === "all" ? [allScope] : ownerScopeParam === "proposal" ? [ownerScopeRoutes.proposal]
    : ownerScopeParam === "routed" ? [ownerScopeRoutes.owner, ownerScopeRoutes.grant, ownerScopeRoutes.proposal] : [];
const ownerScopeCards: import("@wollipog/protocol").PendingApproval[] = ownerScopeChosen.map(({ occurrenceId, snapshot, derivedIncrease }, index) => ({
  ...(derivedIncrease ? { scopeMaxIssuesIncrease: derivedIncrease } : {}),
  requestId: occurrenceId, occurrenceId, kind: "workflow_decision" as const, title: "Campaign Issue Scope Approval Required", async: true,
  options: [{ optionId: "approve", name: "Approve", kind: "allow_once" as const }, { optionId: "deny", name: "Deny", kind: "reject_once" as const }],
  workflowDecision: { requestId: `scope-${occurrenceId}`, occurrenceId, sessionId: "s_root", controllingSessionId: "s_root",
    category: "campaign_issue_scope" as const, resourceKey: "campaign_issue_scope:s_root", resourceSnapshot: snapshot,
    resourceDigest: "d".repeat(64), policyRevision: 1, authority: "human" as const, status: "pending" as const, createdAt: NOW - (index + 2) * MINUTE },
}));
const ownerScopeProjection = (rev: number) => ownerScopeCards.length && rev === 1 ? { status: "waiting_human" as const,
  ownerDecisions: { total: ownerScopeChosen.length, items: ownerScopeChosen.map(({ occurrenceId, summary }, index) => (
    { occurrenceId, sessionId: "s_root", category: "campaign_issue_scope" as const, summary, handedOff: false, createdAt: NOW - (index + 2) * MINUTE })) } } : {};

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

/** `selection=1`: the owner's scope approval for the selection the Decision Model was uncertain about (#4103). */
const selectionCard: import("@wollipog/protocol").PendingApproval | null = params.get("selection") === "1" ? {
  requestId: "wd_sel_3", occurrenceId: "wd_sel_3", kind: "workflow_decision", title: "Scope Approval Required",
  options: [{ optionId: "approve", name: "Approve", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
  workflowDecision: { requestId: "selection-141", occurrenceId: "wd_sel_3", sessionId: "s_root", controllingSessionId: "s_root",
    category: "campaign_issue_scope", resourceKey: "campaign_issue_scope:s_root",
    resourceSnapshot: { category: "campaign_issue_scope", repository: "team/repo", expectedRevision: 2, before: [130, 131], additions: [141], removals: [],
      explanation: "A UI regression three users reported this week.", affectedAssignments: [], affectedDecisions: [], activeChildren: [],
      lineage: { kind: "selection" }, grantReview: { cause: "selection_uncertain", ownerMessage: "Find the 3 highest-priority open issues and fix them",
        messageDigest: "a".repeat(64), reviewOccurrenceId: "sel_uncertain",
        reason: "The owner asked for the highest-priority issues but didn't say whether UI regressions count.",
        selection: { count: 3, defaulted: false, criteria: "highest priority", constraints: ["open"] } } },
    resourceDigest: "c".repeat(64), policyRevision: 1, authority: "human", status: "pending", createdAt: NOW - 60_000 },
} : null;

function sessionsFor(rev: number): SessionView[] {
  const root = baseSession({ orchestratorCampaign: projectionFor(rev),
    ...(pauseFixture ? { commandPermissions: { stop: { allowed: true as const }, restart: { allowed: true as const },
      stopBackgroundJob: { allowed: true as const }, pauseCampaign: params.get("viewer") === "other"
        ? { allowed: false as const, reason: "Only the campaign owner can pause or resume it." } : { allowed: true as const } } } : {}),
    ...(followUpCards.length ? { pendingApproval: { ...followUpCards[0]!, additionalRequests: followUpCards.slice(1) } } : {}),
    ...(ownerCard ? { pendingApproval: ownerCard } : {}),
    ...(selectionCard ? { pendingApproval: selectionCard } : {}),
    ...(ownerScopeCards.length && rev === 1 ? { pendingApproval: { ...ownerScopeCards[0]!, ...(ownerScopeCards.length > 1 ? { additionalRequests: ownerScopeCards.slice(1) } : {}) } } : {}) });
  if (params.get("runnerRecovery") === "1") {
    root.title = "Orchestrator Recovery";
    root.status = "input_required";
    root.pendingApproval = { requestId: "runner-recovery:fixture", kind: "runner_recovery",
      title: "Relaunch Orchestrator After Runner Restart",
      options: [{ optionId: "relaunch", name: "Relaunch Orchestrator", kind: "allow_once" }] };
    root.orchestratorCampaign = { ...root.orchestratorCampaign!, status: "waiting_human",
      pendingRequests: { human: 1, orchestrator: 0 }, ownerDecisions: { total: 1, items: [{
        occurrenceId: "runner-recovery:fixture", sessionId: "s_root", category: "runner_recovery",
        summary: "Relaunch Orchestrator After Runner Restart", handedOff: false, createdAt: NOW,
      }] } };
  }
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
const ownerRequests = (owners: "before" | "after" | "rule"): DescendantRequestView[] => {
  const handed = owners === "after";
  const evaluation = owners !== "before"
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
        ...(handed ? { ownerHandoff: { bySessionId: "s_root", at: NOW - 5 * MINUTE, reason: "The owner kept risk consent for this merge." } } : {}),
        ...(owners === "rule" ? { ownerRule } : {}) } },
  };
  return ownerCard ? [{ sessionId: "s_root", sessionTitle: "Full Control Campaign", runnerId: "runner-1", runnerOnline: true, eventEpoch: 1,
    createdAt: NOW - 4 * MINUTE, responseOwner: "human", authorityEvaluation: ownerCard.workflowDecision!.authorityEvaluation,
    occurrenceId: "workflow_owner_1", request: ownerCard }, ...(params.has("closureRecovery") ? [] : [merge])] : [merge];
};

/** The request the blocked item's recorded blocker names, pending on its child. */
const descendantRequests: DescendantRequestView[] = params.get("runnerRecovery") === "1" ? [{
  sessionId: "s_root", sessionTitle: "Orchestrator Recovery", runnerId: "runner-1", runnerOnline: true,
  eventEpoch: 1, createdAt: NOW, responseOwner: "human", occurrenceId: "runner-recovery:fixture",
  request: { requestId: "runner-recovery:fixture", kind: "runner_recovery", title: "Relaunch Orchestrator After Runner Restart",
    options: [{ optionId: "relaunch", name: "Relaunch Orchestrator", kind: "allow_once" }] },
}] : epicTracking || ownerScopeCards.length ? [] : ownerScenario ? ownerRequests(ownerScenario) : scenario === "campaign" ? [{
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

if (epicTracking) Object.assign(details, epicTracking.details);
const visibleItems = epicTracking?.items ?? (params.has("closureRecovery") ? [itemSummary("cwi_4398", NOW, {
  title: "Uncertain Issue Closure Recovery", issue: { repository: "picoduck/wollipog", number: 4398 }, primaryState: "delivered",
  currentAttempt: null, blocker: null, elapsed: { startedAt: NOW - 12 * MINUTE, endedAt: NOW - MINUTE } })]
  : scenario === "planless" ? items.filter((item) => item.id === "cwi_2" || item.id === "cwi_3") : items);

// The same sentence and versions the control plane returns (campaign-issue-scope.ts).
const SCOPE_GRANT_TARGET = { source: "automatic", runnerId: "r", machineName: "Studio", agentId: "claude", harnessName: "Claude Code",
  driver: "claude-code", provider: "claude", model: "claude-haiku-4-5", effort: "low" } as const;
const LAUNCH_OPERATIONS: import("@wollipog/protocol").CampaignAuthorityOperation[] = ["implementation_question", "pr_merge",
  "merged_branch_deletion", "follow_up_issue_publication", "ui_evidence_approval", "issue_closure", "campaign_issue_scope", "question",
  "tool_approval", "policy_ask"];
const launchCeilings = (maxIssues: number) => ({ repositories: ["team/repo"], maxIssues, maxIssuesSource: "derived" as const, operations: LAUNCH_OPERATIONS });
// `let`: the owner's selection count change (#4102) replaces it, as the server would.
let scopeGrantFixture: import("@wollipog/protocol").FullControlScopeGrant | null = params.get("scope") === "grant" ? {
  version: 1, status: "granted", occurrenceId: "dec_fixture", target: SCOPE_GRANT_TARGET,
  reason: "The owner names #123 and #124, cites #126 as background, and asks for the 5 highest-priority open UI issues without merging.",
  namedIssues: [123, 124], dropped: [{ repository: "team/repo", number: 999, reason: "not_in_message" }],
  selection: { repository: "team/repo", count: 5, defaulted: false, requestedCount: 5, criteria: "highest priority", constraints: ["open", "UI only"] },
  ceilings: { ...launchCeilings(9), operations: LAUNCH_OPERATIONS.filter((operation) => operation !== "pr_merge" && operation !== "merged_branch_deletion"),
    removedOperations: ["pr_merge", "merged_branch_deletion"] },
} : params.get("scope") === "grant-default" ? {
  version: 1, status: "granted", occurrenceId: "dec_fixture", target: SCOPE_GRANT_TARGET,
  reason: "The owner asks the campaign to choose the highest-priority issues and gives no count.", namedIssues: [],
  selection: { repository: "team/repo", count: 3, defaulted: true, criteria: "highest priority", constraints: [] }, ceilings: launchCeilings(4),
} : params.get("scope") === "grant-failed" ? {
  version: 1, status: "failed", occurrenceId: "dec_fixture", target: SCOPE_GRANT_TARGET, failureClass: "provider_overloaded", namedIssues: [],
  ceilings: launchCeilings(1),
} : params.get("scope") === "proposal-repositories" ? {
  // A boundary of two repositories (#4118).
  version: 1, status: "proposal", namedIssues: [], ceilings: { ...launchCeilings(9), repositories: ["team/repo", "team/api"] },
} : params.get("scope") === "all" || params.get("scope") === "proposal" || params.get("scope") === "proposal-waiting" ? {
  // The Orchestrator proposes the scope (#4282): the server read nothing from the message.
  version: 1, status: "proposal", namedIssues: [], ceilings: launchCeilings(params.get("scope") === "all" ? 1 : 9),
} : params.get("scope") === "grant-uncertain" ? {
  version: 1, status: "uncertain", occurrenceId: "dec_fixture", target: SCOPE_GRANT_TARGET, namedIssues: [],
  reason: "The message doesn't say whether #12 is a request or background.", ceilings: launchCeilings(1),
} : null;

/** The constraint check's typed answers for the waiting proposal (#4282): every question satisfied
 * except #152 against "UI only", which the model couldn't settle, so the proposal came to the owner. */
const SCOPE_CHECK_ANSWERS: import("@wollipog/protocol").DecisionTypedAnswersView = (() => {
  const choice = (values: string[]) => ({ type: "choice" as const, values });
  const pairs = [131, 140, 152].flatMap((number) => ["open", "UI only"].map((constraint) => ({ number, constraint })));
  const titles: Record<number, string> = { 123: "Composer Epic", 124: "Member Work", 131: "Sidebar Collapses on Resize", 140: "Badge Contrast in Light Theme",
    152: "Composer Hint Overlaps Send" };
  const questions = [
    { questionId: "count_consistent", label: "Count Matches Your Message", text: "Does the proposal's count agree with the owner's message?",
      answer: choice(["consistent", "inconsistent", "cannot_tell"]) },
    ...[123, 124].map((number, index) => ({ questionId: `named_asked_for__${index + 1}`, label: `team/repo#${number} ${titles[number]}`,
      parameter: `team/repo#${number} ${titles[number]}`, text: "Does the owner's message ask the campaign to work on the issue quoted below?",
      answer: choice(["asked_for", "only_mentioned", "cannot_tell"]) })),
    ...pairs.map(({ number, constraint }, index) => ({ questionId: `constraint_met__${index + 1}`, label: `team/repo#${number} ${titles[number]} — ${constraint}`,
      parameter: `team/repo#${number} ${titles[number]} — ${constraint}`, text: "Does the issue satisfy that constraint?",
      answer: choice(["satisfies", "violates", "cannot_tell"]) })),
    { questionId: "constraints_complete", label: "Every Stated Constraint Listed", text: "Does the proposal list every stated constraint?",
      answer: choice(["complete", "missing_constraint", "cannot_tell"]) },
    { questionId: "nothing_omitted", label: "No Requested Issue Left Out", text: "Does the proposal add every issue the owner asked for?",
      answer: choice(["complete", "omits_requested", "cannot_tell"]) },
    { questionId: "operations_respected", label: "Withheld Operations Respected", text: "Does the proposal withhold every operation the message rules out?",
      answer: choice(["respected", "not_respected", "cannot_tell"]) },
  ];
  const satisfied: Record<string, [string, string]> = { count_consistent: ["consistent", "The owner asks for the 3 highest-priority open UI issues."],
    named_asked_for: ["asked_for", "The owner writes \"Fix #123 and #124\"."], constraint_met: ["satisfies", "It is open and labeled ui."],
    constraints_complete: ["complete", "Open and UI only are the only filters stated."], nothing_omitted: ["complete", "Both named issues are proposed."],
    operations_respected: ["respected", "\"Don't merge anything yet\" withholds PR Merge, which the proposal withholds."] };
  const answers = questions.map((question) => {
    const unsure = question.questionId === "constraint_met__6";
    const [value, evidence] = unsure ? ["cannot_tell", "Its labels don't say whether it is UI work."] : satisfied[question.questionId.split("__")[0]!]!;
    return { questionId: question.questionId, value, confidence: unsure ? 0.55 : 0.93, evidence, assessment: unsure ? "unknown" as const : "satisfied" as const };
  });
  return { confidenceThreshold: 0.8, questions, answers, decisive: { questionId: "constraint_met__6" } };
})();

/** A Custom campaign's first-message proposal check (#4282): the person's message names epic #123.
 * `unsure` leaves whether it asks for #123 below the threshold, so the check is uncertain. */
function seedCheckAnswers(unsure: boolean): import("@wollipog/protocol").DecisionTypedAnswersView {
  const choice = (values: string[]) => ({ type: "choice" as const, values });
  // A parameterized question's label is its parameter: the issue reference and title (issue data,
  // not UI copy), as the server renders it.
  const named = "team/repo#123 Composer Epic";
  const questions = [
    { questionId: "count_consistent", label: "Count Matches Your Message", text: "Does the proposal's count agree with the owner's message?",
      answer: choice(["consistent", "inconsistent", "cannot_tell"]) },
    { questionId: "named_asked_for__1", label: named, parameter: named,
      text: "Does the owner's message ask the campaign to work on the issue quoted below?", answer: choice(["asked_for", "only_mentioned", "cannot_tell"]) },
    { questionId: "constraints_complete", label: "Every Stated Constraint Listed", text: "Does the proposal list every stated constraint?",
      answer: choice(["complete", "missing_constraint", "cannot_tell"]) },
    { questionId: "nothing_omitted", label: "No Requested Issue Left Out", text: "Does the proposal add every issue the owner asked for?",
      answer: choice(["complete", "omits_requested", "cannot_tell"]) },
    { questionId: "operations_respected", label: "Withheld Operations Respected", text: "Does the proposal withhold every operation the message rules out?",
      answer: choice(["respected", "not_respected", "cannot_tell"]) },
  ];
  const satisfied: Record<string, [string, string]> = { count_consistent: ["consistent", "The message states no count, and none was read."],
    named_asked_for: ["asked_for", "The person writes \"Orchestrate epic #123 and its child issues\"."],
    constraints_complete: ["complete", "The message states no filter."], nothing_omitted: ["complete", "#123 is the only issue named."],
    operations_respected: ["respected", "The message rules out no operation."] };
  const answers = questions.map((question) => {
    const doubt = unsure && question.questionId === "named_asked_for__1";
    const [value, evidence] = doubt ? ["cannot_tell", "The message cites #123 as the earlier attempt, not as work to do."] : satisfied[question.questionId.split("__")[0]!]!;
    return { questionId: question.questionId, value, confidence: doubt ? 0.55 : 0.94, evidence, assessment: doubt ? "unknown" as const : "satisfied" as const };
  });
  return { confidenceThreshold: 0.8, questions, answers, ...(unsure ? { decisive: { questionId: "named_asked_for__1" } } : {}) };
}

const SCOPE_PROPOSALS: import("@wollipog/protocol").CampaignScopeProposalView[] = [{
  occurrenceId: "wd_scope_2", createdAt: NOW - 60_000, outcome: "waiting_for_owner",
  explanation: "You named #123 and #124. For the rest I ranked open UI issues by priority label, then by age.",
  check: { occurrenceId: "dec_scope_check", state: "uncertain", verdict: "uncertain", typedAnswers: SCOPE_CHECK_ANSWERS,
    reason: "The answer can't be settled for 'team/repo#152 Composer Hint Overlaps Send — UI only'." },
  proposal: { initial: true, messageDigest: "a".repeat(64), requestedCount: 3, constraints: ["open", "UI only"], withheldOperations: ["pr_merge"],
    checks: ["chosen_issues", "requested_count", "constraints", "withheld_operations"], route: "owner", ownerCause: "constraint_check_uncertain",
    constraintCheck: { occurrenceId: "dec_scope_check", verdict: "uncertain",
      reason: "The answer can't be settled for 'team/repo#152 Composer Hint Overlaps Send — UI only'." },
    ownerMessage: "Fix #123 and #124, then the 3 highest-priority open UI issues. Don't merge anything yet.",
    issues: [
      { number: 123, origin: "owner_named", rationale: "You named it first.", title: "Composer Epic" },
      { number: 124, origin: "owner_named", rationale: "You named it second.", title: "Member Work" },
      { number: 131, origin: "orchestrator_chosen", rationale: "Open, UI, priority:high, oldest.", title: "Sidebar Collapses on Resize" },
      { number: 140, origin: "orchestrator_chosen", rationale: "Open, UI, priority:high.", title: "Badge Contrast in Light Theme" },
      { number: 152, origin: "orchestrator_chosen", rationale: "Open, UI, priority:medium, most reactions.", title: "Composer Hint Overlaps Send" },
    ] },
}, {
  occurrenceId: "wd_scope_1", createdAt: NOW - 120_000, outcome: "replaced",
  explanation: "You named #123 and #124.",
  proposal: { initial: true, messageDigest: "a".repeat(64), requestedCount: null, constraints: [], withheldOperations: [], checks: [], route: "admitted",
    issues: [{ number: 123, origin: "owner_named", rationale: "You named it.", title: "Composer Epic" },
      { number: 124, origin: "owner_named", rationale: "You named it.", title: "Member Work" }] },
}];

/** A proposal across a campaign's repositories (#4118): the same number in two of them is two issues. */
const SCOPE_PROPOSALS_ACROSS_REPOSITORIES: import("@wollipog/protocol").CampaignScopeProposalView[] = [{
  occurrenceId: "wd_scope_3", createdAt: NOW - 60_000, outcome: "waiting_for_owner",
  explanation: "You named team/repo#123 and team/api#123. I chose the worst open API bug by priority label.",
  proposal: { initial: true, messageDigest: "a".repeat(64), requestedCount: null, constraints: [], withheldOperations: [],
    repositoryConstraints: [{ name: "the service repo", repository: null }, { name: "team/api", repository: "team/api" }], checks: ["chosen_issues", "repository_name_unresolved"], route: "owner",
    ownerCause: "repository_name_unresolved", ownerMessage: "Fix team/repo#123 and team/api#123, then the worst open bug in the service repo or team/api, and nothing else.",
    issues: [
      { number: 123, origin: "owner_named", rationale: "You named it.", title: "Composer Epic" },
      { repository: "team/api", number: 123, origin: "owner_named", rationale: "You named it, in the API repository.", title: "Token Refresh Races" },
      { repository: "team/api", number: 140, origin: "orchestrator_chosen", rationale: "Open bug, priority:high.", title: "Timeouts Under Load" },
    ] },
}];

const scopeRequirement = params.get("scope") === "outdated-runner" ? campaignIssueScopeChangesRequirement(207)
  : params.get("scope") === "issue-limits" ? campaignIssueLimitsRequirement(216) : null;
const scopeCompatibility = scopeRequirement ? (({ error, ...versions }) =>
  ({ supported: false, canPropose: false, compatibilityMessage: error, ...versions }))(scopeRequirement)
  : { supported: true, canPropose: true };

/** `screen=1`: the question screen's checks (#4104), one of them waiting for the owner to classify. */
const decisionUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
let screenDecisions: import("@wollipog/protocol").CampaignDecisionsResponse["decisions"] = params.get("screen") === "1" ? [
  { occurrenceId: "dec_keys", kind: "credential_screen", promptVersion: "credential_screen.v1", state: "decided", verdict: "discusses",
    reason: "It asks which keyboard keys the Side Panel tools should use; nothing is handed over.", inputDigests: {},
    target: DECISION_TARGET, attempts: [{ attempt: 1, model: "claude-haiku-5-5", latencyMs: 1_840 }],
    usage: decisionUsage, createdAt: NOW - 240_000, subject: { sessionId: "s_child", surface: "implementation_question", requestId: "keys" } },
  { occurrenceId: "dec_token", kind: "credential_screen", promptVersion: "credential_screen.v1", state: "decided", verdict: "ask",
    reason: "It asks whoever answers to paste a GitHub token.", inputDigests: {}, attempts: [],
    usage: decisionUsage, createdAt: NOW - 180_000, subject: { sessionId: "s_child", surface: "provider_question", requestId: "token" } },
  { occurrenceId: "dec_sessions", kind: "credential_screen", promptVersion: "credential_screen.v1", state: "failed", failureClass: "timed_out",
    target: DECISION_TARGET, inputDigests: {}, attempts: [{ attempt: 1, errorClass: "timed_out", latencyMs: 30_000 }], usage: decisionUsage, createdAt: NOW - 60_000,
    subject: { sessionId: "s_child", surface: "implementation_question", requestId: "sessions" } },
  ...(params.get("owner") === "1" ? [{ occurrenceId: "dec_owner", kind: "credential_screen" as const, promptVersion: "credential_screen.v1",
    state: "uncertain" as const, verdict: "uncertain", reason: "It may ask the owner to sign in to the provider.", inputDigests: {}, attempts: [],
    usage: decisionUsage, createdAt: NOW - 30_000, subject: { sessionId: "s_root", surface: "owner_decision" as const, requestId: "owner" } }] : []),
] : params.get("checks") === "1" ? [
  // `checks=1`: follow-up relatedness and closure-reason checks (#4104 Slice B).
  { occurrenceId: "rel_related", kind: "follow_up_relatedness", promptVersion: "follow_up_relatedness.v1", state: "decided", verdict: "related",
    reason: "It removes a temp file the crash fix exposed.", inputDigests: {}, attempts: [], usage: decisionUsage, createdAt: NOW - 300_000,
    subject: { sessionId: "s_child", surface: "follow_up_publication", requestId: "rec_1" } },
  { occurrenceId: "rel_unrelated", kind: "follow_up_relatedness", promptVersion: "follow_up_relatedness.v1", state: "decided", verdict: "unrelated",
    reason: "It starts a dark-mode theme the owner did not ask for.", inputDigests: {}, attempts: [], usage: decisionUsage, createdAt: NOW - 240_000,
    subject: { sessionId: "s_child", surface: "follow_up_publication", requestId: "rec_2" } },
  { occurrenceId: "why_misfit", kind: "closure_reason", promptVersion: "closure_reason.v1", state: "decided", verdict: "does_not_fit",
    reason: "The recorded reason says the work is only paused.", inputDigests: {}, attempts: [], usage: decisionUsage, createdAt: NOW - 180_000,
    subject: { sessionId: "s_root", surface: "issue_closure", requestId: "team/repo#123" } },
  { occurrenceId: "why_failed", kind: "closure_reason", promptVersion: "closure_reason.v1", state: "failed", failureClass: "timed_out",
    inputDigests: {}, attempts: [], usage: decisionUsage, createdAt: NOW - 60_000,
    subject: { sessionId: "s_root", surface: "issue_closure", requestId: "team/repo#124" } },
  // `seed=1`: a Custom campaign's epic seed (#4104 Slice C): one that seeded an epic, and one whose
  // reading failed, waiting for the owner to approve a scope or continue without an epic.
  ...(params.get("seed") === "1" ? [
    { occurrenceId: "seed_read", kind: "scope_grant" as const, promptVersion: "scope_grant.v1", state: "decided" as const, verdict: "grant",
      reason: "The person names epic #123 and its child issues to orchestrate.", inputDigests: {}, attempts: [], usage: decisionUsage,
      createdAt: NOW - 420_000, subject: { sessionId: "s_root", surface: "issue_scope_seed" as const, requestId: "issue_scope_seed:a", seed: "seeded" as const } },
    { occurrenceId: "seed_failed", kind: "scope_grant" as const, promptVersion: "scope_grant.v1", state: "failed" as const,
      failureClass: "provider_overloaded" as const, inputDigests: {}, attempts: [], usage: decisionUsage, createdAt: NOW - 30_000,
      subject: { sessionId: "s_root", surface: "issue_scope_seed" as const, requestId: "issue_scope_seed:b", seed: "owner" as const } },
  ] : []),
  // `seedcheck=1`: the same seed on the check of the Orchestrator's first-message proposal (#4282):
  // one admitted that seeded the epic, and one uncertain, waiting for the owner.
  ...(params.get("seedcheck") === "1" ? [
    { occurrenceId: "seed_check_seeded", kind: "scope_check" as const, promptVersion: "scope_check.v1", state: "decided" as const, verdict: "admit",
      reason: "Every answer is satisfied with at least 80% confidence.", typedAnswers: seedCheckAnswers(false), inputDigests: {}, attempts: [],
      usage: decisionUsage, createdAt: NOW - 420_000,
      subject: { sessionId: "s_root", surface: "issue_scope_seed" as const, requestId: "issue_scope_seed:c", seed: "seeded" as const } },
    { occurrenceId: "seed_check_uncertain", kind: "scope_check" as const, promptVersion: "scope_check.v1", state: "uncertain" as const,
      verdict: "uncertain", reason: "The answer on 'team/repo#123 Composer Epic' is below the 80% confidence threshold.",
      typedAnswers: seedCheckAnswers(true), inputDigests: {}, attempts: [], usage: decisionUsage, createdAt: NOW - 30_000,
      subject: { sessionId: "s_root", surface: "issue_scope_seed" as const, requestId: "issue_scope_seed:d", seed: "owner" as const } },
  ] : []),
] : params.get("selection") === "1" ? [
  // `selection=1`: the Decision Model's reviews of selection proposals (#4103): admitted, refused and
  // waiting for the owner.
  { occurrenceId: "sel_admitted", kind: "scope_review", promptVersion: "scope_review.v1", state: "decided", verdict: "admit",
    reason: "Both are open, labeled priority/high, and are the oldest such issues.", inputDigests: {}, attempts: [], usage: decisionUsage,
    createdAt: NOW - 300_000, selectionProposal: { outcome: "applied", requestOccurrenceId: "wd_sel_1",
      explanation: "The two oldest open issues labeled priority/high.", issues: [
        { repository: "team/repo", number: 130, title: "Crash when a session restarts during a merge" },
        { repository: "team/repo", number: 131, title: "Campaign Status loses its scroll position" }] } },
  { occurrenceId: "sel_refused", kind: "scope_review", promptVersion: "scope_review.v1", state: "decided", verdict: "refuse",
    reason: "Issue 140 is a wording change, not one of the highest-priority issues the owner asked for.", inputDigests: {}, attempts: [],
    usage: decisionUsage, createdAt: NOW - 180_000, selectionProposal: { outcome: "refused",
      explanation: "Next in the backlog after the priority/high issues.", issues: [
        { repository: "team/repo", number: 140, title: "Reword the Settings footer" }] } },
  { occurrenceId: "sel_uncertain", kind: "scope_review", promptVersion: "scope_review.v1", state: "uncertain", verdict: "uncertain",
    reason: "The owner asked for the highest-priority issues but didn't say whether UI regressions count.", inputDigests: {}, attempts: [],
    usage: decisionUsage, createdAt: NOW - 60_000, humanRequestId: "wd_sel_3", selectionProposal: { outcome: "waiting_for_owner",
      requestOccurrenceId: "wd_sel_3", explanation: "A UI regression three users reported this week.", issues: [
        { repository: "team/repo", number: 141, title: "Sidebar badges overlap on narrow screens" }] } },
] : [];

// `typed=1` (#4283): the same checks as typed questions, each with its answers and the reason the
// server derived from them: the selection reviews with `selection=1`, and the migrated credential
// screen, follow-up relatedness and closure-reason kinds with `screen=1` or `checks=1`. A failed
// check has no answers, so it reads as before.
if (params.get("typed") === "1") {
  const admitted = "Every answer is satisfied with at least 80% confidence.";
  const typed: Record<string, { typedAnswers: DecisionTypedAnswersView; reason: string }> = {
    sel_admitted: { typedAnswers: TYPED_ADMITTED, reason: admitted },
    sel_refused: { typedAnswers: TYPED_REFUSED, reason: "Issue 140 violates 'Skip Security'." },
    sel_uncertain: { typedAnswers: TYPED_UNCERTAIN, reason: "Issue 141 on 'UI Only' is below the 80% confidence threshold." },
    dec_keys: { typedAnswers: TYPED_SCREEN_DISCUSSES, reason: admitted },
    dec_token: { typedAnswers: TYPED_SCREEN_ASK, reason: "The answer violates 'No Credential Handed Over'." },
    dec_owner: { typedAnswers: TYPED_SCREEN_UNCERTAIN, reason: "The answer on 'No Sign-In Performed' is below the 80% confidence threshold." },
    rel_related: { typedAnswers: TYPED_RELATED, reason: admitted },
    rel_unrelated: { typedAnswers: TYPED_UNRELATED, reason: "The answer violates 'Related to the Requested Work'." },
    why_misfit: { typedAnswers: TYPED_CLOSURE_MISFIT, reason: "The answer violates 'Evidence Supports the Reason'." },
  };
  screenDecisions = screenDecisions.map((decision) => typed[decision.occurrenceId]
    ? { ...decision, promptVersion: `${decision.kind}.v2`, ...typed[decision.occurrenceId] } : decision);
}

const client = {
  ...api,
  // `decisions=1` adds three Decision Model calls for the Decision Model section (#4101); the
  // credential checks stay with the Question Screen section (#4104).
  campaignDecisions: async (id: string) => params.get("decisions") === "1"
    ? (() => {
        const fixture = campaignDecisionsFixture(id);
        return { ...fixture, decisions: [...screenDecisions, ...fixture.decisions],
          usage: { ...fixture.usage, calls: fixture.usage.calls + screenDecisions.length } };
      })()
    : ({ campaignSessionId: id, decisions: screenDecisions,
        usage: { ...decisionUsage, calls: screenDecisions.length, unpricedCalls: 0 } }),
  classifyCampaignDecision: async (_id: string, occurrenceId: string, classification: "decline" | "orchestrator") => {
    (window as unknown as { __CLASSIFIED__: unknown }).__CLASSIFIED__ = { occurrenceId, classification };
    screenDecisions = screenDecisions.map((decision) => decision.occurrenceId === occurrenceId
      ? { ...decision, subject: { ...decision.subject!, classification } } : decision);
    return screenDecisions.find((decision) => decision.occurrenceId === occurrenceId)!.subject!;
  },
  campaignIssueScope: async (id: string, epic?: number, _signal?: AbortSignal, epicRepository?: string) => params.get("scope") === "unsupported-target" ? api.campaignIssueScope(id)
    : ({ campaignSessionId: id, repository: "team/repo", issueNumbers: [], revision: 0,
    ...scopeCompatibility, outsideScope: [{ workItemId: "scope-fixture", title: "Member work", issue: { repository: "team/repo", number: 124 }, sessionId: "s_child" }],
    candidates: [{ issue: { repository: "team/repo", number: 123 }, title: "Composer Epic", source: "umbrella" as const },
      { issue: { repository: "team/repo", number: 124 }, title: "Member Work", source: "member_checklist" as const }],
    // A Full Control first message's derived scope and its context-only references (#3920).
    ...(params.get("scope") === "first-message" ? {
      issueNumbers: [123, 124, 125], revision: 2, outsideScope: [], candidates: [], contextIssueNumbers: [126, 127],
    } : {}),
    // The first message's scope grant (#4102): named issues with a selection, a defaulted selection
    // count, and the failure route.
    ...(scopeGrantFixture ? { issueNumbers: scopeGrantFixture.namedIssues, revision: 2, outsideScope: [], candidates: [],
      ...(params.get("scope") === "grant" ? { contextIssueNumbers: [126] } : {}), scopeGrant: scopeGrantFixture, policyRevision: revision } : {}),
    // The Orchestrator's proposals (#4282): one waiting for the owner, after an earlier one it replaced.
    ...(params.get("scope") === "proposal" ? { issueNumbers: [], scopeProposals: SCOPE_PROPOSALS } : {}),
    ...(params.get("scope") === "all" ? { issueNumbers: [], scopeProposals: [{
      occurrenceId: "wd_scope_151", createdAt: NOW - MINUTE, outcome: "waiting_for_owner" as const,
      explanation: allScope.snapshot.explanation, proposal: allScope.snapshot.scopeProposal,
    }] } : {}),
    ...(params.get("scope") === "proposal-waiting" ? { issueNumbers: [], scopeProposals: [] } : {}),
    ...(params.get("scope") === "proposal-repositories" ? { issueNumbers: [], scopeProposals: SCOPE_PROPOSALS_ACROSS_REPOSITORIES, repositories: [
      { repository: "team/repo", issueNumbers: [], state: "verified" as const }, { repository: "team/api", issueNumbers: [], state: "verified" as const }] } : {}),
    // An epic resolved in another repository (#4118): team/repo#123 is held, so team/api#123 is another issue.
    ...(params.get("scope") === "epic-repositories" ? { issueNumbers: [123], revision: 2, outsideScope: [],
      repositories: [{ repository: "team/repo", issueNumbers: [123], state: "verified" as const }, { repository: "team/api", issueNumbers: [], state: "verified" as const }],
      candidates: epic !== undefined && epicRepository === "team/api" ? [
        { issue: { repository: "team/api", number: epic }, title: "Token Refresh Epic", source: "umbrella" as const },
        { issue: { repository: "team/api", number: 140 }, title: "Timeouts Under Load", source: "sub_issue" as const }] : [] } : {}),
    // `activity=…` (#4146): the authorized scope covers every work item, so nothing reads as outside it.
    ...(activityScenario ? { repository: "picoduck/wollipog", revision: 1, canPropose: false, outsideScope: [], candidates: [],
      issueNumbers: [...new Set(items.flatMap((item) => item.issue ? [item.issue.number] : []))] } : {}),
    ...(params.has("closureRecovery") ? { repository: "picoduck/wollipog", revision: 1, issueNumbers: [4398], outsideScope: [], candidates: [] } : {}),
    ...(epicTracking ? { repository: "picoduck/wollipog", revision: 1, canPropose: false, issueNumbers: [4401, 4403], outsideScope: [], candidates: [] } : {}),
    ...(params.get("completedChildren") === "1" && recoveryRecord?.reason === "failed_checks" ? {
      // Disclosed static scope data, not a live mint/approval or supported-profile assertion.
      issueNumbers: [123], revision: 1, canPropose: false, outsideScope: [], candidates: [],
    } : {}) }),
  // The owner's selection count (#4102): a derived Maximum Issues moves by the change, as the server does.
  setScopeGrantSelectionCount: async (_id: string, count: number, expectedRevision: number) => {
    (window as unknown as { __SELECTION_COUNT__: unknown }).__SELECTION_COUNT__ = { count, expectedRevision };
    const grant = scopeGrantFixture!;
    const delta = count - grant.selection!.count;
    scopeGrantFixture = { ...grant, selection: { ...grant.selection!, count, defaulted: false, setByOwner: true },
      ceilings: { ...grant.ceilings, maxIssues: grant.ceilings.maxIssuesSource === "derived" ? grant.ceilings.maxIssues + delta : grant.ceilings.maxIssues } };
    return sessionsFor(revision)[0]!;
  },
  includeCampaignLocation: async (_id: string, locationId: string) => {
    (window as unknown as { __INCLUDED_LOCATION__: unknown }).__INCLUDED_LOCATION__ = locationId;
    included = true;
    window.__WOLLIPOG_CAMPAIGN_STATUS_E2E__.bumpRevision();
    return { joined: true, revision: 7 };
  },
  setCampaignFollowUpLimit: async (_id: string, limit: number | null, expectedRevision: number) => {
    (window as unknown as { __FOLLOW_UP_LIMIT__: unknown }).__FOLLOW_UP_LIMIT__ = { limit, expectedRevision };
    return sessionsFor(revision)[0]!;
  },
  releaseCampaignSlot: async (_id: string, request: import("@wollipog/protocol").ReleaseCampaignSlotRequest) => {
    (window as unknown as { __SLOT_RELEASE__: unknown }).__SLOT_RELEASE__ = request;
    return { sessionId: request.sessionId, title: "#2417 Slice 5: Read API", generation: request.generation, releasedByUserId: "usr_owner",
      releasedByName: "Sam Owner", releasedAt: NOW, reason: request.reason, heldReason: "older_runner" as const,
      settlement: { costUsd: 2.05, toolCalls: 41, source: "checkpoint" as const } };
  },
  deleteCampaignMergedBranches: async (id: string) => {
    (window as unknown as { __DELETE_MERGED_BRANCHES__: unknown }).__DELETE_MERGED_BRANCHES__ = id;
    return { performed: 1, refused: 0 };
  },
  setCampaignPause: async (_id: string, input: { action: "pause" | "resume"; resumeAt?: number | null }) => {
    pauseFixture = input.action === "pause" ? { pausedAt: NOW, pausedBy: "Sam Owner", resumeAt: input.resumeAt ?? null,
      stoppedSessionIds: ["s_child"], inFlightSessionIds: ["s_merge"],
      inFlightWork: [{ sessionId: "s_merge", description: "Merge of team/repo#4560 is still in flight; its merge watch is active." }] }
      : { ...pauseFixture!, resumedAt: NOW, resumedBy: "Sam Owner" };
    revision++;
    setRevision?.(revision);
    for (const session of sessionsFor(revision)) pushToStore?.({ type: "session_upsert", session });
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
      repository: search.get("repository") ?? "all",
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
      ...(workRepositories ? { repositories: fixtureRepositoryCounts(visibleItems) } : {}),
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
    <main className="app" style={{ display: "block", height: (ownerScopeCards.length || params.has("closureRecovery")) && window.innerWidth <= 760 ? "calc(100dvh - var(--bottom-bar-h))" : "100dvh" }}>
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
              {(ownerScopeCards.length > 0 || params.get("closureRecovery") === "owner") && session.pendingApproval && (
                <RequestDock session={session} requests={dockRequests(pendingRequests(withPresentedOwnerQuestions(session).pendingApproval))} runnerOnline />
              )}
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
