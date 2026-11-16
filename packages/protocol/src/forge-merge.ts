/**
 * Gated merge of a session's pull request (#604, protocol v382).
 *
 * One readiness gate decides whether a person may enqueue (a base branch with a merge queue) or
 * directly merge (one without) the session's pull request from Wollipog, and explains every reason
 * it may not. The runner reads the forge facts through its own `gh` login; the control plane adds
 * the facts only it holds (the person's role, open Required findings, runner support). The same
 * functions run in the browser to disable the action, on the control plane before it asks the
 * runner, and on the runner immediately before the forge mutation, so the three cannot disagree.
 * The Pull Request view (#1270) uses them as they are.
 *
 * The action never deletes a branch: it is GitHub's `enqueuePullRequest` or `mergePullRequest`
 * pinned to the head the person saw, never `gh pr merge --delete-branch`. A repository whose own
 * setting deletes head branches after merge is reported (`deleteBranchOnMerge`) so the
 * confirmation can say so. GitLab merge requests are not supported yet and say so.
 */

export type PullRequestMergeMode = "enqueue" | "merge";
export type PullRequestMergeMethod = "squash" | "merge" | "rebase";
export type PullRequestRequiredChecksState = "passed" | "failed" | "pending" | "none";

/** The forge facts one gate decision reads. GitHub only. */
export interface PullRequestMergeFacts {
  url: string;
  repository: string;
  number: number;
  state: "open" | "closed" | "merged";
  headSha: string;
  isDraft: boolean;
  baseRef: string;
  /** The base branch has a merge queue; null when GitHub did not say. */
  mergeQueueEnabled: boolean | null;
  inMergeQueue: boolean;
  /** GitHub's `mergeStateStatus` (`CLEAN`, `DIRTY`, `BEHIND`, `BLOCKED`, ...), when reported. */
  mergeStateStatus: string | null;
  /** The base branch's required checks on `headSha`, an unreported one counting as pending. */
  requiredChecks: { state: PullRequestRequiredChecksState; failing: string[]; pending: string[] };
  /** The runner's GitHub login's permission on the repository, lowercased (`admin`, `write`, ...). */
  viewerPermission: string | null;
  /** The method a direct merge uses: the login's default when the repository allows it, otherwise
   * the first allowed of squash, merge, rebase. A queue applies its own configured method. */
  mergeMethod: PullRequestMergeMethod | null;
  /** The repository deletes head branches after merge (its own setting, not this action). */
  deleteBranchOnMerge: boolean;
  observedAt: number;
}

/** The runner's answer to a readiness read. */
export interface GitMergeReadinessInfo {
  facts: PullRequestMergeFacts | null;
  /** Sentence-case reason `facts` is null: an unsupported forge, no pull request, a failed read. */
  unavailable?: string;
}

export type PullRequestMergeBlockerCode =
  | "unavailable"
  | "not_open"
  | "draft"
  | "in_queue"
  | "forge_permission"
  | "checks_failed"
  | "checks_pending"
  | "conflicts"
  | "behind"
  | "blocked"
  | "merge_state_unknown"
  | "no_merge_method"
  | "role"
  | "runner_unsupported"
  | "required_findings";

export interface PullRequestMergeBlocker {
  code: PullRequestMergeBlockerCode;
  /** One sentence-case sentence a disabled action shows. */
  message: string;
}

export interface PullRequestMergeReadiness {
  /** Enqueue when the base has a merge queue, merge when it has none, null when unknown. */
  mode: PullRequestMergeMode | null;
  /** Title Case action label. */
  label: "Enqueue for Merge" | "Merge Pull Request";
  ready: boolean;
  blockers: PullRequestMergeBlocker[];
  /** The head an approval of this decision is pinned to. */
  headSha: string | null;
  mergeMethod: PullRequestMergeMethod | null;
}

/** Facts only the control plane holds. */
export interface PullRequestMergeSessionFacts {
  /** The person's refusal for the merge command (role), or null when allowed. */
  roleRefusal: string | null;
  runnerSupported: boolean;
  /** Open (or sent) Required review findings; null when they could not be read (fails closed). */
  requiredFindingsOpen: number | null;
}

/** Repository permissions that may merge. */
const MERGING_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export function pullRequestMergeMode(facts: PullRequestMergeFacts | null | undefined): PullRequestMergeMode | null {
  if (!facts || facts.mergeQueueEnabled === null) return null;
  return facts.mergeQueueEnabled ? "enqueue" : "merge";
}

function list(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/** Every forge-side reason the pull request cannot be enqueued or merged now. */
export function forgeMergeBlockers(facts: PullRequestMergeFacts | null | undefined, unavailable?: string): PullRequestMergeBlocker[] {
  if (!facts) {
    return [{ code: "unavailable", message: unavailable ?? "The pull request's merge state could not be read." }];
  }
  if (facts.state !== "open") {
    return [{ code: "not_open", message: `This pull request is already ${facts.state === "merged" ? "merged" : "closed"}.` }];
  }
  const blockers: PullRequestMergeBlocker[] = [];
  const mode = pullRequestMergeMode(facts);
  if (mode === null) {
    blockers.push({ code: "unavailable", message: "GitHub did not say whether the base branch uses a merge queue." });
  }
  if (facts.inMergeQueue) blockers.push({ code: "in_queue", message: "This pull request is already in the merge queue." });
  if (facts.isDraft) blockers.push({ code: "draft", message: "Draft pull requests can't be merged; mark it ready for review first." });
  if (!MERGING_PERMISSIONS.has((facts.viewerPermission ?? "").toLowerCase())) {
    blockers.push({ code: "forge_permission", message: `This machine's GitHub account can't merge into ${facts.repository}.` });
  }
  if (facts.requiredChecks.state === "failed") {
    blockers.push({ code: "checks_failed", message: `Required checks failed on the current head: ${list(facts.requiredChecks.failing)}.` });
  } else if (facts.requiredChecks.state === "pending") {
    blockers.push({
      code: "checks_pending",
      message: facts.requiredChecks.pending.length > 0
        ? `Required checks haven't passed on the current head yet: ${list(facts.requiredChecks.pending)}.`
        : "Required checks haven't passed on the current head yet.",
    });
  }
  // GitHub's own verdict on every base-branch rule, reviews included. The runner's login may be an
  // admin that GitHub would let merge past those rules, so anything but a mergeable state blocks
  // (fails closed): UNSTABLE means only optional checks are unfinished, HAS_HOOKS is mergeable, and
  // BEHIND is fine for a queue, which tests the pull request on top of the latest base anyway.
  const mergeState = facts.mergeStateStatus;
  const checksDecided = facts.requiredChecks.state === "passed" || facts.requiredChecks.state === "none";
  if (mergeState === "DIRTY") {
    blockers.push({ code: "conflicts", message: `The pull request has merge conflicts with ${facts.baseRef}.` });
  } else if (mergeState === "BEHIND" && mode !== "enqueue") {
    blockers.push({ code: "behind", message: `The branch is behind ${facts.baseRef}; update it before merging.` });
  } else if (mergeState === "BLOCKED") {
    // Pending or failing required checks already explain a blocked state.
    if (checksDecided) {
      blockers.push({ code: "blocked", message: "GitHub reports the base branch's rules are not met yet, such as a required review." });
    }
  } else if (!["CLEAN", "HAS_HOOKS", "UNSTABLE", "BEHIND"].includes(mergeState ?? "")) {
    blockers.push({ code: "merge_state_unknown", message: "GitHub hasn't worked out whether this pull request can merge yet; try again in a moment." });
  }
  if (mode === "merge" && facts.mergeMethod === null) {
    blockers.push({ code: "no_merge_method", message: "The repository allows no merge method for pull requests." });
  }
  return blockers;
}

/** Every control-plane reason the person cannot run the action now. */
export function sessionMergeBlockers(session: PullRequestMergeSessionFacts): PullRequestMergeBlocker[] {
  const blockers: PullRequestMergeBlocker[] = [];
  if (session.roleRefusal !== null) blockers.push({ code: "role", message: session.roleRefusal });
  if (!session.runnerSupported) {
    blockers.push({ code: "runner_unsupported", message: "This machine's runner can't merge pull requests; update it first." });
  }
  if (session.requiredFindingsOpen === null) {
    blockers.push({ code: "required_findings", message: "Open Required findings could not be read." });
  } else if (session.requiredFindingsOpen > 0) {
    const count = session.requiredFindingsOpen;
    blockers.push({
      code: "required_findings",
      message: `Resolve the ${count === 1 ? "open Required finding" : `${count} open Required findings`} first.`,
    });
  }
  return blockers;
}

/**
 * The readiness gate (#604): the action is enabled only when every forge and session condition
 * holds. `blockers` lists every failing condition, session ones first, so a disabled action can
 * explain all of them at once.
 */
export function pullRequestMergeReadiness(
  facts: PullRequestMergeFacts | null | undefined,
  session: PullRequestMergeSessionFacts,
  unavailable?: string,
): PullRequestMergeReadiness {
  const mode = pullRequestMergeMode(facts);
  const blockers = [...sessionMergeBlockers(session), ...forgeMergeBlockers(facts, unavailable)];
  return {
    mode,
    label: mode === "enqueue" ? "Enqueue for Merge" : "Merge Pull Request",
    ready: blockers.length === 0 && mode !== null,
    blockers,
    headSha: facts?.headSha ?? null,
    mergeMethod: mode === "merge" ? facts?.mergeMethod ?? null : null,
  };
}

/** `GET /api/sessions/:id/pull-request/merge-readiness`. */
export interface PullRequestMergeReadinessResponse {
  facts: PullRequestMergeFacts | null;
  unavailable?: string;
  readiness: PullRequestMergeReadiness;
}

/** `POST /api/sessions/:id/pull-request/merge`: the exact pull request, head and mode the person
 * confirmed. A changed head or mode refuses rather than merging something else. */
export interface PullRequestMergeRequest {
  pullRequestUrl: string;
  headSha: string;
  mode: PullRequestMergeMode;
}

export type PullRequestMergeOutcome = "enqueued" | "merged" | "refused" | "uncertain";

/** The runner's result, verified by reading the pull request back after the mutation. */
export interface GitMergeResultInfo {
  outcome: PullRequestMergeOutcome;
  /** One sentence for the person. */
  message: string;
  mode: PullRequestMergeMode;
  headSha: string;
  /** The read-back state, when the read succeeded. */
  state: "open" | "closed" | "merged" | null;
  /** The read-back queue entry, when it is in the queue. */
  queuePosition?: number | null;
}

export interface PullRequestMergeResponse {
  result: GitMergeResultInfo;
}

const SHA = /^[0-9a-f]{40}$/u;

/** Validate a merge request body; returns an error sentence or the request. */
export function parsePullRequestMergeRequest(value: unknown): PullRequestMergeRequest | { error: string } {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!raw) return { error: "a pull request, head and mode are required" };
  if (typeof raw.pullRequestUrl !== "string" || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/u.test(raw.pullRequestUrl)) {
    return { error: "pullRequestUrl must be a github.com pull request URL" };
  }
  if (typeof raw.headSha !== "string" || !SHA.test(raw.headSha)) return { error: "headSha must be a full 40-character commit SHA" };
  if (raw.mode !== "enqueue" && raw.mode !== "merge") return { error: "mode must be enqueue or merge" };
  return { pullRequestUrl: raw.pullRequestUrl, headSha: raw.headSha, mode: raw.mode };
}
