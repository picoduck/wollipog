import type { AssistantDecisionHistoryEntry, AssistantDecisionHistoryPage } from "@wollipog/protocol";

export function assistantDecisionHistoryFixture(campaignId: string, before?: string): AssistantDecisionHistoryPage {
  const entries: AssistantDecisionHistoryEntry[] = Array.from({ length: 24 }, (_, index) => ({
    occurrenceId: `workflow_${index}`,
    sessionId: campaignId,
    category: index % 2 === 0 ? "pr_merge" : "owner_question",
    resourceKey: index % 2 === 0 ? `picoduck/wollipog#${126 - index}` : "Release scope",
    delegation: { threadId: "thr_triage", ownerUserId: "owner-fixture", organizationId: "org-fixture",
      grantRevision: 3, campaignId, resolvedAt: Date.UTC(2026, 10, 19, 16, index),
      outcome: index % 2 === 0 ? "approved" : "answered",
      reason: index === 0 ? "The required checks passed and the review covered the current head."
        : index === 1 ? "The scope covers the reviewed work. " + "ReleaseCandidateVerification".repeat(12)
        : "The exact decision matches the approved release scope.",
    },
  }));
  return before ? { entries: entries.slice(20) } : { entries: entries.slice(0, 20), nextBefore: "fixture-next" };
}
