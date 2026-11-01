import { runnerSupportsProtocol, type RunnerRuntimeInfo, type ReviewSessionCapability } from "@wollipog/protocol";

/** A malformed entry must not remove the other harness. Normalize registration and refresh alike. */
export function safeReviewSessionCapability(value: unknown): ReviewSessionCapability | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as ReviewSessionCapability;
  if (!Array.isArray(input.reviewers)) return undefined;
  const reviewers: ReviewSessionCapability["reviewers"] = [];
  const unavailable: NonNullable<ReviewSessionCapability["unavailable"]> = {};
  for (const key of ["claude-code", "codex", "tools"] as const) {
    const reason = input.unavailable?.[key];
    if (reason === undefined) continue;
    unavailable[key] = typeof reason !== "string" || !reason.trim()
      ? "runner reported an invalid review-session unavailability reason; refresh agent discovery"
      : reason.length <= 500 ? reason : `${reason.slice(0, 450)}… (+${reason.length - 450} more characters)`;
  }
  if (input.unavailable !== undefined && (!input.unavailable || typeof input.unavailable !== "object" || Array.isArray(input.unavailable))) {
    unavailable.tools = "runner reported invalid review-session unavailability reasons; refresh agent discovery";
  }
  for (const harness of ["claude-code", "codex"] as const) {
    const entries = input.reviewers.filter((entry) => entry?.harness === harness);
    const valid = entries.filter((entry) => typeof entry.agentId === "string" && entry.agentId.trim().length > 0 && entry.agentId.length <= 128);
    if (valid.length === 1) reviewers.push({ harness, agentId: valid[0]!.agentId });
    else unavailable[harness] ??= entries.length
      ? "runner reported invalid or ambiguous reviewer entries; refresh agent discovery"
      : unavailable.tools ?? "reviewer not advertised by the runner; refresh agent discovery";
  }
  reviewers.sort((a, b) => input.reviewers.findIndex((entry) => entry?.harness === a.harness) -
    input.reviewers.findIndex((entry) => entry?.harness === b.harness));
  return {
    reviewers,
    ...(input.questionPreservation === true ? { questionPreservation: true as const } : {}),
    ...(input.configuration === true ? { configuration: true as const } : {}),
    ...(Object.keys(unavailable).length ? { unavailable } : {}),
  };
}

/** Gate the trusted marker on actual support, never on an unrelated later protocol bump. */
export function runnerSupportsReviewQuestionPreservation(runner: {
  protocolVersion?: number | null;
  runtime?: Pick<RunnerRuntimeInfo, "reviewSession"> | null;
} | null | undefined): boolean {
  return runnerSupportsProtocol(runner?.protocolVersion, "reviewSession") &&
    runner?.runtime?.reviewSession?.questionPreservation === true;
}
