/**
 * Campaign work ledger fixtures for the Campaign Status tests and evidence harness (#2417). Every
 * builder returns a complete, contract-shaped value; callers override only what a case is about.
 */
import type {
  CampaignCostValue,
  CampaignForgePullRequestObservation,
  CampaignMetric,
  CampaignWorkItemDetail,
  CampaignWorkItemSummary,
  CampaignWorkSummary,
  OrchestratorCampaignProjection,
} from "@wollipog/protocol";

export const MINUTE = 60_000;

/** A GitHub observation (slice 8): an open pull request waiting in the merge queue, required checks
 * passing, the rest still running, and no review decision. */
export function forgeObservation(overrides: Partial<CampaignForgePullRequestObservation> = {}): CampaignForgePullRequestObservation {
  return {
    state: "open",
    draft: false,
    headSha: "44579c6c25235598f1a28f8ccb0449cb8dbbc810",
    baseRef: "main",
    reviewDecision: "none",
    checks: { state: "pending", passing: 8, failing: 0, pending: 1 },
    requiredChecks: { state: "passing", passing: 1, failing: 0, pending: 0 },
    mergeQueue: { state: "awaiting_checks", position: 2 },
    mergeCommitSha: null,
    ...overrides,
  };
}

export function knownCost(usd: number, source: CampaignCostValue["source"] = "providerReported", unpricedRecords = 0): CampaignMetric<CampaignCostValue> {
  return { availability: "known", value: { usd, source, unpricedRecords } };
}

export function workSummary(now: number, overrides: Partial<CampaignWorkSummary> = {}): CampaignWorkSummary {
  return {
    revision: 1,
    planState: "recorded",
    coverage: { untrackedChildren: 0, predatesLedger: false },
    counts: {
      committed: 3, delivered: 1, original: 2, followUp: 1, cancelled: 0, removed: 0,
      byState: { planned: 1, queued: 0, running: 1, waiting: 0, blocked: 0, delivered: 1, cancelled: 0, removed: 0 },
    },
    recommendations: { awaiting_adjudication: 0, accepted: 1, rejected: 1, deferred: 0, duplicate: 2 },
    obligations: { verification: 1, adjudication: 0, publication: 0, cleanup: 0 },
    elapsed: { startedAt: now - 10 * MINUTE, endedAt: null },
    cost: {
      total: knownCost(2.5),
      workItems: knownCost(2),
      coordination: knownCost(0.5),
      unattributed: knownCost(0),
      attributedSince: now - 10 * MINUTE,
    },
    ...overrides,
  };
}

export function campaignProjection(work: CampaignWorkSummary | null, overrides: Partial<OrchestratorCampaignProjection> = {}): OrchestratorCampaignProjection {
  return {
    status: "active",
    policyRevision: 1,
    decisionOwners: {},
    limits: { maximumConcurrentChildren: 4, occupied: 1, remaining: 3, costBudgetUsd: null, maxToolCalls: null },
    uiEvidenceReview: { status: "available", effectiveOwner: "orchestrator" },
    children: { total: 2, active: 1, waitingHuman: 0, blocked: 0, verified: 1, cleanupPending: 0 },
    pendingDecisions: { human: 0, orchestrator: 0 },
    followUps: { unique: 1, duplicates: 2 },
    ...(work ? { work } : {}),
    ...overrides,
  } as OrchestratorCampaignProjection;
}

export function itemSummary(id: string, now: number, overrides: Partial<CampaignWorkItemSummary> = {}): CampaignWorkItemSummary {
  const number = Number(id.replace(/\D/g, "")) || 1;
  return {
    id,
    key: `picoduck/wollipog#${number}`,
    title: `Work ${id}`,
    issue: { repository: "picoduck/wollipog", number },
    origin: "original",
    generation: 0,
    primaryState: "running",
    stateCauses: [],
    commitment: "committed",
    dispatchState: "queued",
    queuePosition: number,
    currentAttempt: { id: `catt_${number}`, sessionId: "s_child", sessionTitle: "Child One" },
    attemptCount: 1,
    stage: null,
    blocker: null,
    createdAt: now - 20 * MINUTE,
    updatedAt: now,
    activityAt: now,
    elapsed: { startedAt: now - 5 * MINUTE, endedAt: null },
    ...overrides,
  };
}

export function itemDetail(summary: CampaignWorkItemSummary, overrides: Partial<CampaignWorkItemDetail> = {}): CampaignWorkItemDetail {
  const attempt = summary.currentAttempt;
  return {
    ...summary,
    dependsOn: [],
    dependents: [],
    nextAction: null,
    commitmentRecord: { state: summary.commitment, reason: null, changedAt: summary.createdAt, changedBySessionId: "s_root" },
    attempts: attempt ? [{
      id: attempt.id,
      workItemId: summary.id,
      ordinal: 1,
      sessionId: attempt.sessionId,
      session: {
        title: attempt.sessionTitle,
        harness: { agentId: "claude-native", driver: "claude-code", context: { kind: "native" } },
        agentName: "Claude Code (native)",
        model: null,
        effort: null,
      },
      assignedBySessionId: "s_root",
      startedAt: summary.elapsed.startedAt ?? summary.createdAt,
      start: { eventEpoch: 1, runnerHistoryEpoch: null, seq: 1 },
      endedAt: null,
      end: null,
      endReason: null,
      endNote: null,
    }] : [],
    verifications: [],
    sourceRecommendation: null,
    recommendations: [],
    observed: {
      session: attempt?.sessionId
        ? { availability: "fresh", value: { sessionId: attempt.sessionId, status: "running", archived: false, held: false, pendingRequests: 0 }, observedAt: summary.updatedAt }
        : undefined,
    },
    ...overrides,
  } as CampaignWorkItemDetail;
}
