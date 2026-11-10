import type { OrchestratorCampaignProjection } from "@wollipog/protocol";
import { itemDetail, itemSummary, knownCost, MINUTE, workSummary } from "./campaign-status-fixtures.js";

/** Mirrors the real ledger cases in campaign-recovery.integration.test.ts (#4403): a verified
 * member-proven epic closure finishes ended tracking work, but cannot finish delivery work. */
export function epicTrackingFixture(now: number, mode: "complete" | "delivery" | "legacy") {
  const deliveryWork = mode === "delivery", incomplete = mode !== "complete", legacy = mode === "legacy";
  const totalCost = legacy ? 1 : 1.25;
  const member = itemSummary("cwi_44031", now, {
    title: "Delivered Member Work", issue: { repository: "picoduck/wollipog", number: 44031 },
    primaryState: "delivered", currentAttempt: null, blocker: null,
    elapsed: { startedAt: now - 12 * MINUTE, endedAt: now - 5 * MINUTE }, cost: knownCost(1),
    stage: { stage: "merged", note: null, sourceSessionId: "s_root", reportedAt: now - 5 * MINUTE,
      pullRequests: [{ repository: "picoduck/wollipog", number: 44032 }] },
  });
  const epic = itemSummary("cwi_4403", now, {
    title: legacy ? "Legacy Epic Tracking" : deliveryWork ? "Epic With Delivery Work" : "Epic Tracking", issue: { repository: "picoduck/wollipog", number: 4403 },
    primaryState: incomplete ? "planned" : "delivered", currentAttempt: null, blocker: null, attemptCount: legacy ? 0 : 1,
    elapsed: legacy ? { startedAt: null, endedAt: null } : { startedAt: now - 4 * MINUTE, endedAt: now - MINUTE }, cost: knownCost(legacy ? 0 : 0.25),
    stage: deliveryWork ? { stage: "implementing", note: "Delivery work still needs its own verified delivery.",
      sourceSessionId: "s_root", reportedAt: now - MINUTE, pullRequests: [] } : null,
  });
  const attempt = itemDetail(itemSummary(epic.id, now)).attempts[0]!;
  const detail = itemDetail(epic, { attempts: legacy ? [] : [{ ...attempt, endedAt: now - MINUTE,
    end: { eventEpoch: 1, runnerHistoryEpoch: null, seq: 2 }, endReason: "failed",
    endNote: "Tracking attempt ended without delivering work." }] });
  const projection = (revision: number): Partial<OrchestratorCampaignProjection> => ({
    status: incomplete ? "stuck" : "verified_complete", children: { total: 2, active: 0, waitingHuman: 0,
      blocked: 0, verified: 2, cleanupPending: 0 }, limits: { maximumConcurrentChildren: 3, occupied: 0,
      remaining: 3, costBudgetUsd: null, maxToolCalls: null }, heldChildren: [],
    pendingDecisions: { human: 0, orchestrator: 0 }, followUps: { unique: 0, duplicates: 0 }, activity: { live: [] },
    ...(incomplete ? { stuck: { total: 1, items: [{ kind: "work_item" as const, workItemId: epic.id,
      issue: epic.issue,
      reason: legacy ? "Historical delivery work cannot be verified for this item." : "The epic's delivery work still needs its own verified delivery." }] } } : {}),
    work: workSummary(now, { revision, counts: { committed: 2, delivered: incomplete ? 1 : 2,
      original: 2, followUp: 0, cancelled: 0, removed: 0, byState: { planned: incomplete ? 1 : 0,
        queued: 0, running: 0, waiting: 0, blocked: 0, delivered: incomplete ? 1 : 2, cancelled: 0, removed: 0 } },
      recommendations: { awaiting_adjudication: 0, accepted: 0, rejected: 0, deferred: 0, duplicate: 0 },
      obligations: { verification: 0, adjudication: 0, publication: 0, cleanup: 0 },
      elapsed: { startedAt: now - 12 * MINUTE, endedAt: incomplete ? null : now - MINUTE },
      cost: { total: knownCost(totalCost), workItems: knownCost(totalCost), coordination: knownCost(0),
        unattributed: knownCost(0), attributedSince: now - 12 * MINUTE } }),
  });
  return { items: [member, epic], details: { [member.id]: itemDetail(member), [epic.id]: detail }, projection };
}
