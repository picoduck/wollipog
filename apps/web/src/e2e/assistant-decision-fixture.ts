import type { AssistantDecisionHistoryEntry, AssistantDecisionHistoryPage, AssistantDecisionOutcome } from "@wollipog/protocol";

const ciRerunKey = "ci_rerun:engineering/release-validation:44699507825:2";
const ciRerunSubject = "engineering/release-validation · Run 44699507825 · Attempt 2 · Build and Bundle";

const outcomes = ["approved", "answered", "denied"] as const;
const stressReason = "ReleaseCandidateVerification".repeat(12).slice(0, 300);

export function assistantDecisionHistoryFixture(campaignId: string, options: {
  before?: string; outcome?: AssistantDecisionOutcome; release?: boolean; stress?: boolean; legacy?: boolean;
} = {}): AssistantDecisionHistoryPage {
  const { before, outcome, release, stress, legacy } = options;
  const entries: AssistantDecisionHistoryEntry[] = Array.from({ length: 24 }, (_, index) => ({
    occurrenceId: `workflow_${index}`,
    sessionId: campaignId,
    category: index === 2 ? "ci_rerun" : stress && index === 3 ? "merged_branch_deletion" : index % 2 === 0 ? "pr_merge" : "owner_question",
    resourceKey: index === 1 ? "Release scope for the November candidate and every change from the migration rehearsal through the current signed build"
      : index === 2 ? ciRerunKey
      : stress && index === 3 ? "merged_branch_deletion:picoduck/wollipog:feature/" + "ReleaseValidation".repeat(4)
      : index % 2 === 0 ? `picoduck/wollipog#${126 - index}` : "Release scope",
    ...(index === 2 ? { subject: ciRerunSubject } : {}),
    delegation: { threadId: "thr_triage", threadTitle: stress && index === 1
      ? "Triage Open Issues With " + "ReleaseValidation".repeat(4) : "Triage Open Issues",
      ownerUserId: "owner-fixture", organizationId: "org-fixture",
      grantRevision: 3, campaignId, resolvedAt: Date.UTC(2026, 9, 19, 16, index),
      outcome: outcomes[index % outcomes.length]!,
      reason: index === 0 ? "The required checks passed and the review covered the current head."
        : index === 1 ? stressReason
        : "The exact decision matches the approved release scope.",
    },
  }));
  if (release) {
    for (const [index, category] of (["release_publish", "release_tag"] as const).entries()) {
      const entry = entries[index]!;
      entries[index] = { ...entry, category,
        resourceKey: `${category}:engineering/release-validation:v0.38.0`, subject: "engineering/release-validation · v0.38.0",
        delegation: { ...entry.delegation, outcome: "approved", reason: "The approval binds the exact release target and payload." } };
    }
  }
  const offset = Number(before ?? 0);
  const counts = { approved: 0, denied: 0, answered: 0 };
  for (const entry of entries) counts[entry.delegation.outcome]++;
  const filtered = outcome && !legacy ? entries.filter((entry) => entry.delegation.outcome === outcome) : entries;
  return {
    entries: filtered.slice(offset, offset + 5),
    ...(offset + 5 < filtered.length ? { nextBefore: String(offset + 5) } : {}),
    ...(!before && !legacy ? { outcomeCounts: counts } : {}),
  };
}
