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

/* The migrated #4104 kinds as typed questions (#4283, slice 2): the credential screen's three
   yes-or-no questions, follow-up relatedness's one choice and closure-reason choice's two. */

const NO_ASK_QUESTIONS: DecisionTypedAnswersView["questions"] = [
  { questionId: "hands_over_credential", label: "No Credential Handed Over",
    text: "Would answering or approving this request make whoever answers supply, disclose, enter or send a credential?",
    answer: { type: "boolean" } },
  { questionId: "performs_sign_in", label: "No Sign-In Performed",
    text: "Would answering or approving this request sign in, or authorize a device, an application or an account?",
    answer: { type: "boolean" } },
  { questionId: "grants_access", label: "No Access Granted",
    text: "Would answering or approving this request widen provider, repository or sandbox permissions?",
    answer: { type: "boolean" } },
];

/** A design question about keyboard keys: no to all three, so the Orchestrator decides it. */
export const TYPED_SCREEN_DISCUSSES: DecisionTypedAnswersView = {
  confidenceThreshold: 0.8,
  questions: NO_ASK_QUESTIONS,
  answers: [
    { questionId: "hands_over_credential", value: false, confidence: 0.97, evidence: "It asks which keyboard keys open the tools.", assessment: "satisfied" },
    { questionId: "performs_sign_in", value: false, confidence: 0.98, evidence: "Nothing signs in.", assessment: "satisfied" },
    { questionId: "grants_access", value: false, confidence: 0.96, evidence: "No permission changes.", assessment: "satisfied" },
  ],
};

/** A request to paste a token: a confident yes, so it is declined. */
export const TYPED_SCREEN_ASK: DecisionTypedAnswersView = {
  confidenceThreshold: 0.8,
  questions: NO_ASK_QUESTIONS,
  answers: [
    { questionId: "hands_over_credential", value: true, confidence: 0.98, evidence: "\"Paste a GitHub token here.\"", assessment: "violated" },
    { questionId: "performs_sign_in", value: false, confidence: 0.85, evidence: "It asks for a token, not a sign-in.", assessment: "satisfied" },
    { questionId: "grants_access", value: false, confidence: 0.82, evidence: "No permission is named.", assessment: "satisfied" },
  ],
  decisive: { questionId: "hands_over_credential" },
};

/** A yes below the threshold: uncertain, so the owner classifies it. */
export const TYPED_SCREEN_UNCERTAIN: DecisionTypedAnswersView = {
  confidenceThreshold: 0.8,
  questions: NO_ASK_QUESTIONS,
  answers: [
    { questionId: "hands_over_credential", value: false, confidence: 0.9, evidence: "No credential is requested.", assessment: "satisfied" },
    { questionId: "performs_sign_in", value: true, confidence: 0.6, evidence: "One option says \"sign in to the provider again\".", assessment: "violated" },
    { questionId: "grants_access", value: false, confidence: 0.88, evidence: "No permission changes.", assessment: "satisfied" },
  ],
  decisive: { questionId: "performs_sign_in" },
};

const RELATION_QUESTION: DecisionTypedAnswersView["questions"] = [
  { questionId: "relation", label: "Related to the Requested Work", text: "How does this follow-up relate to the work the owner asked for?",
    answer: { type: "choice", values: ["completes_requested_work", "gap_found_in_requested_work", "separate_work", "cannot_tell"] } },
];

export const TYPED_RELATED: DecisionTypedAnswersView = {
  confidenceThreshold: 0.8,
  questions: RELATION_QUESTION,
  answers: [{ questionId: "relation", value: "gap_found_in_requested_work", confidence: 0.91,
    evidence: "The crash fix exposed the leftover temp file.", assessment: "satisfied" }],
};

export const TYPED_UNRELATED: DecisionTypedAnswersView = {
  confidenceThreshold: 0.8,
  questions: RELATION_QUESTION,
  answers: [{ questionId: "relation", value: "separate_work", confidence: 0.93,
    evidence: "It starts a dark-mode theme the owner did not ask for.", assessment: "violated" }],
  decisive: { questionId: "relation" },
};

export const TYPED_CLOSURE_MISFIT: DecisionTypedAnswersView = {
  confidenceThreshold: 0.8,
  questions: [
    { questionId: "evidence_supports_reason", label: "Evidence Supports the Reason",
      text: "Does the recorded evidence support closing this issue for the stated reason?",
      answer: { type: "choice", values: ["supports", "does_not_support", "cannot_tell"] } },
    { questionId: "explanation_consistent", label: "Explanation Matches the Evidence",
      text: "Is the agent's explanation consistent with the recorded evidence?",
      answer: { type: "choice", values: ["consistent", "contradicts_evidence", "cannot_tell"] } },
  ],
  answers: [
    { questionId: "evidence_supports_reason", value: "does_not_support", confidence: 0.88,
      evidence: "The recorded reason says the work is only paused.", assessment: "violated" },
    { questionId: "explanation_consistent", value: "consistent", confidence: 0.84, evidence: "It says the work was set aside.", assessment: "satisfied" },
  ],
  decisive: { questionId: "evidence_supports_reason" },
};
