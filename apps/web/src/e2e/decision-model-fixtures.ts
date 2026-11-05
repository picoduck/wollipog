import type { CampaignDecisionsResponse, DecisionModelResolvedTarget, DecisionOccurrenceView } from "@wollipog/protocol";

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
