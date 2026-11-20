import type { AssistantDecisionHistoryEntry, AssistantDecisionHistoryPage } from "@wollipog/protocol";

const ciRerunKey = "ci_rerun:engineering/release-validation:44699507825:2";
const ciRerunSubject = "engineering/release-validation · Run 44699507825 · Attempt 2 · Build and Bundle";

export function assistantDecisionHistoryFixture(campaignId: string, before?: string): AssistantDecisionHistoryPage {
  const entries: AssistantDecisionHistoryEntry[] = Array.from({ length: 24 }, (_, index) => ({
    occurrenceId: `workflow_${index}`,
    sessionId: campaignId,
    category: index === 2 ? "ci_rerun" : index % 2 === 0 ? "pr_merge" : "owner_question",
    resourceKey: index === 1 ? "Release scope for the November candidate and every change from the migration rehearsal through the current signed build"
      : index === 2 ? ciRerunKey
      : index % 2 === 0 ? `picoduck/wollipog#${126 - index}` : "Release scope",
    ...(index === 2 ? { subject: ciRerunSubject } : {}),
    delegation: { threadId: "thr_triage", threadTitle: "Triage Open Issues", ownerUserId: "owner-fixture", organizationId: "org-fixture",
      grantRevision: 3, campaignId, resolvedAt: Date.UTC(2026, 9, 19, 16, index),
      outcome: index % 2 === 0 ? "approved" : "answered",
      reason: index === 0 ? "The required checks passed and the review covered the current head."
        : index === 1 ? "The scope covers the reviewed work. " + "ReleaseCandidateVerification".repeat(12)
        : "The exact decision matches the approved release scope.",
    },
  }));
  const offset = Number(before ?? 0);
  return { entries: entries.slice(offset, offset + 5), ...(offset + 5 < entries.length ? { nextBefore: String(offset + 5) } : {}) };
}
