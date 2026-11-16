/**
 * Gated enqueue or direct merge of a session's pull request (#604), through this runner's `gh`
 * login. The readiness gate is `@wollipog/protocol`'s; this module supplies its forge facts and
 * performs the one mutation the person confirmed:
 *
 * - The facts come from the pull request wait's own one-shot evaluation (required checks from the
 *   base branch's rules, an unreported required check pending) plus one GraphQL read of the
 *   repository's merge settings and the runner login's permission.
 * - The mutation is GitHub's `enqueuePullRequest` (a merge-queue base) or `mergePullRequest` with
 *   the repository's method (no queue), both pinned with `expectedHeadOid`. Neither deletes a
 *   branch, neither arms auto-merge, and neither can merge another head.
 * - The facts are read again and the gate re-run immediately before the mutation, and the pull
 *   request is read back afterwards: only the read-back says `enqueued` or `merged`.
 *
 * Every refusal is a fixed sentence or GitHub's own GraphQL error message, never `gh` stderr.
 */
import {
  forgeMergeBlockers,
  pullRequestMergeMode,
  type GitMergeResultInfo,
  type PullRequestMergeFacts,
  type PullRequestMergeMethod,
  type PullRequestMergeMode,
  type PullRequestRequiredChecksState,
} from "@wollipog/protocol";
import { classifyGhFailure, type GhRunner } from "./campaign-forge-status.js";
import { githubPullRequestFromUrl } from "./pull-request-queue.js";
import { readPullRequestQueue, waitForPullRequest, type PullRequestWaitSummary } from "./pull-request-wait.js";

const SETTINGS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    nameWithOwner viewerPermission viewerDefaultMergeMethod deleteBranchOnMerge
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    pullRequest(number:$number){ id number headRefOid isMergeQueueEnabled isInMergeQueue }
  }
}`;

const ENQUEUE_MUTATION = `mutation($id:ID!,$head:GitObjectID!){
  enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){ mergeQueueEntry{ state position } }
}`;

const MERGE_MUTATION = `mutation($id:ID!,$head:GitObjectID!,$method:PullRequestMergeMethod!){
  mergePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:$method}){ pullRequest{ state } }
}`;

const MAX_NAMES = 10;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const FAILURE_WORDS: Record<string, string> = {
  forge_cli_missing: "gh is not installed on this machine.",
  forge_unauthenticated: "gh on this machine is not signed in to github.com.",
  forge_unreachable: "github.com could not be reached.",
  forge_rate_limited: "github.com rate-limited this machine's gh login.",
};

/** The direct-merge method: the login's default when allowed, else the first allowed. */
export function directMergeMethod(settings: Record<string, unknown>): PullRequestMergeMethod | null {
  const allowed: PullRequestMergeMethod[] = [];
  if (settings.squashMergeAllowed === true) allowed.push("squash");
  if (settings.mergeCommitAllowed === true) allowed.push("merge");
  if (settings.rebaseMergeAllowed === true) allowed.push("rebase");
  const preferred = typeof settings.viewerDefaultMergeMethod === "string"
    ? settings.viewerDefaultMergeMethod.toLowerCase() as PullRequestMergeMethod : null;
  return preferred && allowed.includes(preferred) ? preferred : allowed[0] ?? null;
}

/** Required checks on the head, from one wait observation. Only GitHub's own decisive pass, or
 * every required check reported passing on a complete read, counts as passed. */
export function requiredChecksFromWait(summary: PullRequestWaitSummary): PullRequestMergeFacts["requiredChecks"] {
  const required = summary.checks.required;
  const failing = required.filter((check) => check.state === "failed").map((check) => check.name);
  const pending = required.filter((check) => check.state === "pending" || !check.reported).map((check) => check.name);
  let state: PullRequestRequiredChecksState;
  if (summary.outcome === "checks_passed") state = "passed";
  else if (summary.outcome === "no_required_checks") state = "none";
  else if (failing.length > 0) state = "failed";
  else if (required.length === 0 && summary.requiredCheckNames?.length === 0) state = "none";
  else if (pending.length > 0 || summary.checks.truncated || required.length === 0) state = "pending";
  else state = "passed";
  return {
    state,
    failing: state === "failed" ? failing.slice(0, MAX_NAMES) : [],
    pending: state === "pending" ? pending.slice(0, MAX_NAMES) : [],
  };
}

type FactsRead = { ok: true; facts: PullRequestMergeFacts; nodeId: string } | { ok: false; reason: string };

/** Read every fact the readiness gate needs for one github.com pull request. */
export async function readPullRequestMergeFacts(
  pullRequestUrl: string,
  gh: GhRunner,
  now: () => number = Date.now,
): Promise<FactsRead> {
  const ref = githubPullRequestFromUrl(pullRequestUrl);
  if (!ref) return { ok: false, reason: "Merging from Wollipog supports github.com pull requests only." };
  const [owner, name] = ref.repository.split("/");
  const settingsRead = await gh(["api", "graphql", "--hostname", "github.com", "-f", `query=${SETTINGS_QUERY}`,
    "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${ref.number}`]);
  if (settingsRead.code !== null) {
    return { ok: false, reason: FAILURE_WORDS[classifyGhFailure(settingsRead)] ?? "GitHub could not be read for the pull request." };
  }
  const response = record(parseJson(settingsRead.stdout));
  const repository = response && !response.errors ? record(record(response.data)?.repository) : null;
  const pr = record(repository?.pullRequest);
  if (!repository || !pr || typeof pr.id !== "string" || pr.number !== ref.number ||
      typeof repository.nameWithOwner !== "string" || repository.nameWithOwner.toLowerCase() !== ref.repository.toLowerCase()) {
    return { ok: false, reason: "GitHub returned an unexpected answer for the pull request." };
  }
  const waited = await waitForPullRequest({ repository: ref.repository, number: ref.number, timeoutMs: 1 }, { gh, now });
  if (!waited.ok) return { ok: false, reason: "GitHub could not be read for the pull request's checks." };
  const summary = waited.summary;
  return {
    ok: true,
    nodeId: pr.id,
    facts: {
      url: pullRequestUrl,
      repository: ref.repository,
      number: ref.number,
      state: summary.state,
      headSha: summary.headSha,
      isDraft: summary.isDraft,
      baseRef: summary.baseRef,
      mergeQueueEnabled: typeof pr.isMergeQueueEnabled === "boolean" ? pr.isMergeQueueEnabled : null,
      inMergeQueue: pr.isInMergeQueue === true || summary.mergeQueue !== null,
      mergeStateStatus: summary.mergeStateStatus,
      requiredChecks: requiredChecksFromWait(summary),
      viewerPermission: typeof repository.viewerPermission === "string" ? repository.viewerPermission.toLowerCase() : null,
      mergeMethod: directMergeMethod(repository),
      deleteBranchOnMerge: repository.deleteBranchOnMerge === true,
      observedAt: now(),
    },
  };
}

function graphqlErrorMessage(stdout: string): string | null {
  const errors = record(parseJson(stdout))?.errors;
  if (!Array.isArray(errors)) return null;
  const message = errors.map((error) => record(error)?.message).find((value): value is string => typeof value === "string" && value.length > 0);
  return message ? message.replace(/\s+/gu, " ").slice(0, 200) : null;
}

/**
 * Enqueue or merge the pull request exactly as confirmed: the same pull request, head and mode,
 * with every gate condition still met on a fresh read. The result comes from reading it back.
 */
export async function mergePullRequest(
  request: { pullRequestUrl: string; headSha: string; mode: PullRequestMergeMode },
  gh: GhRunner,
  now: () => number = Date.now,
): Promise<GitMergeResultInfo> {
  const result = (outcome: GitMergeResultInfo["outcome"], message: string, extra: Partial<GitMergeResultInfo> = {}): GitMergeResultInfo =>
    ({ outcome, message, mode: request.mode, headSha: request.headSha, state: null, ...extra });
  const read = await readPullRequestMergeFacts(request.pullRequestUrl, gh, now);
  if (!read.ok) return result("refused", read.reason);
  const { facts } = read;
  if (facts.state !== "open") {
    return result("refused", `This pull request is already ${facts.state === "merged" ? "merged" : "closed"}.`, { state: facts.state });
  }
  if (facts.headSha !== request.headSha) {
    return result("refused", "The pull request's head changed since you confirmed; review the new head first.", { state: facts.state });
  }
  if (pullRequestMergeMode(facts) !== request.mode) {
    return result("refused", "The base branch's merge queue setting changed since you confirmed; reload and try again.", { state: facts.state });
  }
  const blockers = forgeMergeBlockers(facts);
  if (blockers.length > 0) return result("refused", blockers[0]!.message, { state: facts.state });

  const args = request.mode === "enqueue"
    ? ["api", "graphql", "--hostname", "github.com", "-f", `query=${ENQUEUE_MUTATION}`, "-f", `id=${read.nodeId}`, "-f", `head=${request.headSha}`]
    : ["api", "graphql", "--hostname", "github.com", "-f", `query=${MERGE_MUTATION}`, "-f", `id=${read.nodeId}`, "-f", `head=${request.headSha}`,
      "-f", `method=${facts.mergeMethod!.toUpperCase()}`];
  const mutation = await gh(args);
  const refusal = graphqlErrorMessage(mutation.stdout);

  // Read back, whatever the mutation printed: an accepted request is proven by the pull request
  // itself, and a transport failure may still have landed.
  const back = await readPullRequestQueue(facts.repository, facts.number, gh);
  if (back.ok && back.value.state === "merged") {
    return result("merged", request.mode === "enqueue"
      ? "GitHub merged the pull request from the merge queue."
      : `Merged with the repository's ${facts.mergeMethod} method.`, { state: "merged" });
  }
  if (back.ok && back.value.entry && back.value.headSha === request.headSha) {
    return result("enqueued", back.value.entry.position
      ? `Added to the merge queue at position ${back.value.entry.position}.`
      : "Added to the merge queue.", { state: "open", queuePosition: back.value.entry.position });
  }
  const state = back.ok ? back.value.state : null;
  if (refusal) return result("refused", `GitHub refused: ${refusal}`, { state });
  if (mutation.code !== null) {
    return result("uncertain", `${FAILURE_WORDS[classifyGhFailure(mutation)] ?? "GitHub did not confirm the request."} Check the pull request before trying again.`, { state });
  }
  return result("uncertain", request.mode === "enqueue"
    ? "GitHub accepted the request, but the pull request is not in the merge queue yet. Check it before trying again."
    : "GitHub accepted the request, but the pull request has not merged yet. Check it before trying again.", { state });
}
