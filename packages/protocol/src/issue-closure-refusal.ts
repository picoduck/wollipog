/**
 * Why an approved issue closure came back `refused` (#4059).
 *
 * A refusal is always decided before the forge is written: the runner refuses before its durable
 * mutation fence, the control plane records one when the runner replied `ok: false` or never
 * received the request, and every later failure is `uncertain` instead. The approval is consumed
 * either way, so a retry needs a new closure request and its own decision.
 *
 * Each refusal branch in the runner and the control plane maps to exactly one reason below. A peer
 * that predates reasons yields `unspecified` (a result) or `runner_failed` (an `ok: false` reply),
 * and the outcome stays `refused`. New branches add a reason here; consumers that meet an unknown
 * reason from a newer peer read it as `unspecified`.
 */

export const GITHUB_ISSUE_CLOSURE_REFUSAL_REASONS = [
  /** The runner's repository is not the one the closure was approved for. */
  "repository_changed",
  /** The issue's own title, body, labels, assignees or last update changed. */
  "issue_changed",
  /** A related open pull request appeared or left the set; `pullRequests` names each. */
  "related_pull_requests_changed",
  /** A related open pull request gained or lost a closing reference; `pullRequests` names each. */
  "closing_reference_changed",
  /** The forge evidence changed, but the approved snapshot predates per-PR attribution. */
  "forge_evidence_changed",
  /** Orchestrator-owned closure: a related pull request is open; `pullRequests` names each. */
  "related_pull_request_open",
  /** Orchestrator-owned closure: the verified delivery changed; `pullRequests` names each. */
  "delivery_changed",
  /** The runner's campaign scope, scope revision or bounded closure authority no longer matches. */
  "campaign_authority_changed",
  /** The runner could not record its one-time mutation fence for this occurrence. */
  "mutation_fence_unavailable",
  /** The runner could not read complete issue evidence; `runnerError` says what. */
  "evidence_unavailable",
  /** The runner refused for another reason; `runnerError` carries its sanitized message. */
  "runner_failed",
  /** The request never reached the runner. */
  "runner_unreachable",
  /** The runner refused without a reason: it predates refusal reasons. */
  "unspecified",
] as const;

export type GithubIssueClosureRefusalReason = typeof GITHUB_ISSUE_CLOSURE_REFUSAL_REASONS[number];

/** Reasons a runner's `refused` execution result may carry. */
export const GITHUB_ISSUE_CLOSURE_RESULT_REFUSAL_REASONS: readonly GithubIssueClosureRefusalReason[] = [
  "repository_changed", "issue_changed", "related_pull_requests_changed", "closing_reference_changed",
  "forge_evidence_changed", "related_pull_request_open", "delivery_changed", "mutation_fence_unavailable",
];

/** Reasons a runner's `ok: false` closure reply may carry as its `failure`. */
export const GITHUB_ISSUE_CLOSURE_FAILURE_REASONS: readonly GithubIssueClosureRefusalReason[] = [
  "repository_changed", "campaign_authority_changed", "evidence_unavailable", "runner_failed",
];

/** The longest runner message a refusal keeps. */
export const GITHUB_ISSUE_CLOSURE_RUNNER_ERROR_MAX = 300;

export interface GithubIssueClosureRefusal {
  reason: GithubIssueClosureRefusalReason;
  /** The pull or merge requests the reason names, ascending; omitted when it names none. */
  pullRequests?: number[];
  /** The runner's own message, sanitized and bounded by the control plane. */
  runnerError?: string;
  /** A refusal is decided before any forge write: nothing was written. */
  forgeWritten: false;
  /** The approval is consumed; closing the issue needs a new closure request. */
  nextStep: "request_new_closure";
  /** One sentence derived from the fields above, for agents and the Inbox. */
  summary: string;
}

const REASON_TEXT: Record<GithubIssueClosureRefusalReason, string> = {
  repository_changed: "The runner's repository no longer matches the approved closure",
  issue_changed: "The issue changed after the closure was requested",
  related_pull_requests_changed: "The related open pull requests changed after the closure was requested",
  closing_reference_changed: "A related open pull request gained or lost a closing reference to the issue",
  forge_evidence_changed: "The issue or its related pull requests changed after the closure was requested",
  related_pull_request_open: "A related pull request is still open",
  delivery_changed: "The verified delivery changed after the closure was requested",
  campaign_authority_changed: "The campaign's scope or closure authority changed before the closure ran",
  mutation_fence_unavailable: "The runner could not record its one-time closure attempt",
  evidence_unavailable: "The runner could not read complete issue evidence",
  runner_failed: "The runner refused the closure",
  runner_unreachable: "The closure request never reached the runner",
  unspecified: "The runner refused without giving a reason",
};

const REASONS: ReadonlySet<string> = new Set(GITHUB_ISSUE_CLOSURE_REFUSAL_REASONS);

export function isGithubIssueClosureRefusalReason(value: unknown): value is GithubIssueClosureRefusalReason {
  return typeof value === "string" && REASONS.has(value);
}

function pullRequestNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = [...new Set(value.filter((item): item is number => Number.isSafeInteger(item) && item > 0))]
    .sort((a, b) => a - b).slice(0, 100);
  return numbers.length ? numbers : undefined;
}

/** What went wrong, without the next step: the reason, the PRs it names and the runner's message. */
export function githubIssueClosureRefusalReasonText(refusal: Pick<GithubIssueClosureRefusal, "reason" | "pullRequests" | "runnerError">): string {
  const text = REASON_TEXT[isGithubIssueClosureRefusalReason(refusal.reason) ? refusal.reason : "unspecified"];
  const named = refusal.pullRequests?.length ? `: ${refusal.pullRequests.map((number) => `#${number}`).join(", ")}` : "";
  const error = refusal.runnerError;
  const said = error ? ` The runner said: ${error}${/[.!?…]$/u.test(error) ? "" : "."}` : "";
  return `${text}${named}.${said}`;
}

/** The one canonical refusal for a reason; its summary is always derived, never accepted. */
export function githubIssueClosureRefusal(
  reason: GithubIssueClosureRefusalReason,
  details: { pullRequests?: readonly number[]; runnerError?: string } = {},
): GithubIssueClosureRefusal {
  const pullRequests = pullRequestNumbers(details.pullRequests);
  const runnerError = typeof details.runnerError === "string" && details.runnerError.trim()
    ? details.runnerError.trim().slice(0, GITHUB_ISSUE_CLOSURE_RUNNER_ERROR_MAX) : undefined;
  const fields = { reason, ...(pullRequests ? { pullRequests } : {}), ...(runnerError ? { runnerError } : {}) };
  return {
    ...fields,
    forgeWritten: false,
    nextStep: "request_new_closure",
    summary: `${githubIssueClosureRefusalReasonText(fields)} Nothing was written; request a new closure to try again.`,
  };
}

/** A stored or received refusal, rebuilt canonically; an unknown reason reads as `unspecified`. */
export function normalizeGithubIssueClosureRefusal(value: unknown): GithubIssueClosureRefusal {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return githubIssueClosureRefusal(isGithubIssueClosureRefusalReason(record.reason) ? record.reason : "unspecified", {
    ...(Array.isArray(record.pullRequests) ? { pullRequests: record.pullRequests as number[] } : {}),
    ...(typeof record.runnerError === "string" ? { runnerError: record.runnerError } : {}),
  });
}
