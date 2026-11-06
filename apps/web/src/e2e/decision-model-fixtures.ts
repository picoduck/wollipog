import type {
  CampaignDecisionsResponse,
  DecisionModelResolvedTarget,
  DecisionOccurrenceView,
  DecisionTypedAnswersView,
} from "@wollipog/protocol";

/** Decision Model fixtures (#4101) shared by the e2e harnesses: one confirmed, one uncertain and one
 * failed decision, and their campaign usage. */
export const DECISION_TARGET: DecisionModelResolvedTarget = {
  source: "automatic",
  runnerId: "runner-studio",
  machineName: "Studio Workstation",
  agentId: "claude-code",
  harnessName: "Claude Code",
  driver: "claude-code",
  provider: "claude",
  model: "haiku",
  modelName: "Haiku",
  effort: "low",
};

export const DECIDED: DecisionOccurrenceView = {
  occurrenceId: "dec_probe",
  kind: "probe",
  promptVersion: "probe.v1",
  state: "decided",
  verdict: "confirm",
  reason: "picoduck/example is listed in the boundary.",
  target: DECISION_TARGET,
  inputDigests: {},
  attempts: [{ attempt: 1, latencyMs: 3_140 }],
  usage: { inputTokens: 210, outputTokens: 48, cacheReadInputTokens: 0, cacheCreationInputTokens: 3_208, costUsd: 0.0052 },
  createdAt: Date.UTC(2026, 10, 5, 7, 0),
};

const { verdict: _verdict, reason: _reason, ...withoutAnswer } = DECIDED;

export function campaignDecisionsFixture(campaignSessionId: string): CampaignDecisionsResponse {
  return {
    campaignSessionId,
    decisions: [
      DECIDED,
      {
        ...DECIDED,
        occurrenceId: "dec_uncertain",
        state: "uncertain",
        verdict: "uncertain",
        reason: "The request names two repositories and the boundary lists one.",
        humanRequestId: "wfd_owner",
      },
      {
        ...withoutAnswer,
        occurrenceId: "dec_failed",
        state: "failed",
        failureClass: "runner_incapable",
        attempts: [{ attempt: 1, errorClass: "runner_incapable", latencyMs: 0 }],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 },
      },
    ],
    usage: { calls: 3, inputTokens: 420, outputTokens: 96, cacheReadInputTokens: 0, cacheCreationInputTokens: 6_416, costUsd: 0.0104, unpricedCalls: 0 },
  };
}

/* Typed answers (#4283): a selection checked against the owner's stated count and constraints, as
   typed questions with a confidence and evidence each, and the verdict the server derived. */

const CHOICES = { type: "choice", values: ["satisfies", "violates", "cannot_tell"] } as const;

function constraintQuestions(items: Array<{ number: number }>): DecisionTypedAnswersView["questions"] {
  const subject = items.map((item) => ({ id: `team/repo#${item.number}`, label: `Issue ${item.number}` }));
  return [
    { questionId: "count_matches", label: "Count Matches", text: "Does the proposed count match the count the owner stated?",
      answer: { type: "boolean" } },
    { questionId: "satisfies_constraint__1", label: "UI Only", text: "Does this issue satisfy the owner's constraint quoted below?",
      answer: CHOICES, items: subject },
    { questionId: "satisfies_constraint__2", label: "Skip Security", text: "Does this issue satisfy the owner's constraint quoted below?",
      answer: CHOICES, items: subject },
  ];
}

/** Both proposed issues satisfy every constraint with confidence: admitted. */
export const TYPED_ADMITTED: DecisionTypedAnswersView = {
  confidenceThreshold: 0.8,
  questions: constraintQuestions([{ number: 130 }, { number: 131 }]),
  answers: [
    { questionId: "count_matches", value: true, confidence: 0.97, evidence: "The owner asked for two; two are proposed.", assessment: "satisfied" },
    { questionId: "satisfies_constraint__1", itemId: "team/repo#130", value: "satisfies", confidence: 0.88,
      evidence: "Labeled area/ui: the merge banner.", assessment: "satisfied" },
    { questionId: "satisfies_constraint__1", itemId: "team/repo#131", value: "satisfies", confidence: 0.93,
      evidence: "Labeled area/ui: Campaign Status scrolling.", assessment: "satisfied" },
    { questionId: "satisfies_constraint__2", itemId: "team/repo#130", value: "satisfies", confidence: 0.95,
      evidence: "No security label.", assessment: "satisfied" },
    { questionId: "satisfies_constraint__2", itemId: "team/repo#131", value: "satisfies", confidence: 0.95,
      evidence: "No security label.", assessment: "satisfied" },
  ],
};

/** Issue 140 violates "Skip Security" with confidence: refused, naming the question and the item. */
export const TYPED_REFUSED: DecisionTypedAnswersView = {
  confidenceThreshold: 0.8,
  questions: constraintQuestions([{ number: 140 }]),
  answers: [
    { questionId: "count_matches", value: true, confidence: 0.96, evidence: "The owner asked for one more; one is proposed.", assessment: "satisfied" },
    { questionId: "satisfies_constraint__1", itemId: "team/repo#140", value: "satisfies", confidence: 0.9,
      evidence: "It rewords the Settings footer.", assessment: "satisfied" },
    { questionId: "satisfies_constraint__2", itemId: "team/repo#140", value: "violates", confidence: 0.92,
      evidence: "It is labeled security.", assessment: "violated" },
  ],
  decisive: { questionId: "satisfies_constraint__2", itemId: "team/repo#140" },
};

/** One answer below the threshold: uncertain, so the scope change waits for the owner. */
export const TYPED_UNCERTAIN: DecisionTypedAnswersView = {
  confidenceThreshold: 0.8,
  questions: constraintQuestions([{ number: 141 }]),
  answers: [
    { questionId: "count_matches", value: true, confidence: 0.94, evidence: "One more was asked for; one is proposed.", assessment: "satisfied" },
    { questionId: "satisfies_constraint__1", itemId: "team/repo#141", value: "satisfies", confidence: 0.55,
      evidence: "A layout bug, but the label is area/sidebar, not area/ui.", assessment: "satisfied" },
    { questionId: "satisfies_constraint__2", itemId: "team/repo#141", value: "satisfies", confidence: 0.9,
      evidence: "No security label.", assessment: "satisfied" },
  ],
  decisive: { questionId: "satisfies_constraint__1", itemId: "team/repo#141" },
};
