/**
 * Wollipog-performed forge actions (#4067, protocol v279; see `@wollipog/protocol`
 * forge-decision-action). The control plane has already checked the approval, its authority and
 * its snapshot; this module performs exactly the one approved action through the child session's
 * own `gh` login, after re-reading the forge, and reports a fixed outcome. Nothing `gh` prints
 * crosses back: every failure is a fixed code and sentence.
 *
 * Only `gh api` against an explicit `owner/repo` is used. No `git` runs in the session's worktree,
 * so nothing the agent can write there (hooks, `core.sshCommand`, credential helpers, `insteadOf`
 * rewrites, a changed `origin`) is ever executed or consulted by the runner on its behalf.
 *
 * - A branch deletion proves the pull request merged the approved head from the approved branch in
 *   the same repository with the approved merge commit, that no open pull request targets the
 *   branch, and that the remote tip is still the approved head. It then deletes the ref through
 *   GitHub's `updateRefs` mutation with `beforeOid` set to that head, so GitHub itself refuses the
 *   deletion if the tip moved after the read.
 * - An enqueue proves the pull request is open at the approved head, then runs the canonical
 *   `gh pr merge <url> --squash --match-head-commit <sha>`. A pull request already in the queue,
 *   or already merged at that head, is the approved action having taken effect.
 */
import type {
  ForgeDecisionAction,
  ForgeDecisionActionOutcome,
  ForgeDecisionActionRefusalReason,
} from "@wollipog/protocol";
import { forgeActionBranchName } from "@wollipog/protocol";
import { classifyGhFailure, type GhRunner } from "./campaign-forge-status.js";

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const ZERO_OID = "0".repeat(40);

export interface ForgeDecisionActionResult {
  outcome: ForgeDecisionActionOutcome;
  refusal?: { reason: ForgeDecisionActionRefusalReason; summary: string };
}

const refused = (reason: ForgeDecisionActionRefusalReason, summary: string): ForgeDecisionActionResult =>
  ({ outcome: "refused", refusal: { reason, summary } });

const UNAVAILABLE_WORDS: Record<string, string> = {
  forge_cli_missing: "gh is not installed in this session's context.",
  forge_unauthenticated: "gh in this session's context is not signed in to github.com.",
  forge_unreachable: "github.com could not be reached.",
  forge_rate_limited: "github.com rate-limited this gh login.",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** One GraphQL read; the repository object, or a refusal. */
async function readRepository(
  gh: GhRunner, query: string, repository: string, variables: Array<[string, string]>,
): Promise<{ data: Record<string, unknown> } | { refusal: ForgeDecisionActionResult }> {
  const [owner, name] = repository.split("/");
  const args = ["api", "graphql", "--hostname", "github.com", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
  for (const [key, value] of variables) args.push(key === "number" ? "-F" : "-f", `${key}=${value}`);
  const outcome = await gh(args);
  if (outcome.code !== null) {
    return { refusal: refused("forge_unavailable", UNAVAILABLE_WORDS[classifyGhFailure(outcome)] ?? "GitHub returned an error.") };
  }
  try {
    const response = record(JSON.parse(outcome.stdout));
    const data = response && !response.errors ? record(record(response.data)?.repository) : null;
    if (data && typeof data.nameWithOwner === "string" && data.nameWithOwner.toLowerCase() === repository.toLowerCase()) return { data };
  } catch { /* falls through */ }
  return { refusal: refused("forge_unavailable", "GitHub returned an unexpected answer for the pull request.") };
}

const DELETION_QUERY = `query($owner:String!,$name:String!,$number:Int!,$ref:String!,$branch:String!){
  repository(owner:$owner,name:$name){ id nameWithOwner
    pullRequest(number:$number){ number state headRefName headRefOid isCrossRepository mergeCommit{ oid } }
    ref(qualifiedName:$ref){ target{ oid } }
    pullRequests(states:OPEN, baseRefName:$branch, first:1){ totalCount }
  }
}`;

const DELETION_MUTATION = `mutation($repositoryId:ID!,$ref:GitRefname!,$before:GitObjectID!,$after:GitObjectID!){
  updateRefs(input:{repositoryId:$repositoryId, refUpdates:[{name:$ref, beforeOid:$before, afterOid:$after}]}){ clientMutationId }
}`;

/** What the branch looks like now: gone, at a tip, or unreadable. */
async function branchTip(gh: GhRunner, action: Extract<ForgeDecisionAction, { kind: "branch_deletion" }>): Promise<string | null | undefined> {
  const read = await readRepository(gh, `query($owner:String!,$name:String!,$ref:String!){
    repository(owner:$owner,name:$name){ nameWithOwner ref(qualifiedName:$ref){ target{ oid } } } }`,
  action.repository, [["ref", `refs/heads/${action.branch}`]]);
  if ("refusal" in read) return undefined;
  if (read.data.ref === null) return null;
  const tip = record(record(read.data.ref)?.target)?.oid;
  return typeof tip === "string" ? tip : undefined;
}

export async function executeBranchDeletion(
  action: Extract<ForgeDecisionAction, { kind: "branch_deletion" }>,
  gh: GhRunner,
): Promise<ForgeDecisionActionResult> {
  if (!REPOSITORY.test(action.repository) || !forgeActionBranchName(action.branch) || !Number.isSafeInteger(action.pullRequest) ||
      action.pullRequest < 1 || !SHA.test(action.headSha) || !SHA.test(action.mergeCommitSha)) {
    return refused("pull_request_mismatch", "The decision does not name a GitHub branch this runner can delete.");
  }
  const ref = `refs/heads/${action.branch}`;
  const read = await readRepository(gh, DELETION_QUERY, action.repository, [
    ["number", String(action.pullRequest)], ["ref", ref], ["branch", action.branch],
  ]);
  if ("refusal" in read) return read.refusal;
  const pr = record(read.data.pullRequest);
  const current = read.data.ref === null ? null : record(read.data.ref);
  const tip = current ? record(current.target)?.oid : null;
  const dependents = record(read.data.pullRequests)?.totalCount;
  if (!pr || pr.number !== action.pullRequest || (current && typeof tip !== "string") || !Number.isSafeInteger(dependents) ||
      typeof read.data.id !== "string" || !read.data.id) {
    return refused("forge_unavailable", "GitHub returned an unexpected answer for the pull request.");
  }
  if (pr.state !== "MERGED" || pr.headRefName !== action.branch || pr.headRefOid !== action.headSha ||
      pr.isCrossRepository !== false || record(pr.mergeCommit)?.oid !== action.mergeCommitSha) {
    return refused("pull_request_mismatch", "The pull request did not merge the approved head from this branch with the approved merge commit.");
  }
  if ((dependents as number) > 0) {
    return refused("dependent_pull_request_open", "An open pull request targets this branch, so it was left alone.");
  }
  if (current === null) return { outcome: "already_deleted" };
  if (tip !== action.headSha) {
    return refused("tip_moved", "The branch tip is no longer the approved merged head, so it was left alone.");
  }
  // GitHub applies `beforeOid` atomically: the deletion happens only while the tip is the head.
  const deleted = await gh(["api", "graphql", "--hostname", "github.com", "-f", `query=${DELETION_MUTATION}`,
    "-f", `repositoryId=${read.data.id}`, "-f", `ref=${ref}`, "-f", `before=${action.headSha}`, "-f", `after=${ZERO_OID}`]);
  if (deleted.timedOut) return { outcome: "uncertain" };
  let accepted = false;
  if (deleted.code === null) {
    try {
      const response = record(JSON.parse(deleted.stdout));
      accepted = Boolean(response && !response.errors && record(record(response.data)?.updateRefs));
    } catch { accepted = false; }
  }
  if (accepted) return { outcome: "deleted" };
  const failure = deleted.code === null ? null : classifyGhFailure(deleted);
  if (failure && UNAVAILABLE_WORDS[failure]) return refused("forge_unavailable", `${UNAVAILABLE_WORDS[failure]} Nothing was deleted.`);
  // GitHub refused the update. Read the branch again to say why, without trusting the error text.
  const after = await branchTip(gh, action);
  if (after === null) return { outcome: "already_deleted" };
  if (typeof after === "string" && after !== action.headSha) {
    return refused("tip_moved", "The branch tip moved before the deletion, so it was left alone.");
  }
  if (after === undefined) return { outcome: "uncertain" };
  return refused("forge_refused", "GitHub refused the deletion (for example, a branch protection rule); nothing was deleted.");
}

const ENQUEUE_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ nameWithOwner
    pullRequest(number:$number){ number state headRefOid mergeQueueEntry{ state } }
  }
}`;

export async function executePullRequestEnqueue(
  action: Extract<ForgeDecisionAction, { kind: "pr_merge_enqueue" }>,
  gh: GhRunner,
): Promise<ForgeDecisionActionResult> {
  if (!REPOSITORY.test(action.repository) || !Number.isSafeInteger(action.pullRequest) || action.pullRequest < 1 || !SHA.test(action.headSha)) {
    return refused("pull_request_mismatch", "The decision does not name a GitHub pull request this runner can enqueue.");
  }
  const read = await readRepository(gh, ENQUEUE_QUERY, action.repository, [["number", String(action.pullRequest)]]);
  if ("refusal" in read) return read.refusal;
  const pr = record(read.data.pullRequest);
  if (!pr || pr.number !== action.pullRequest || typeof pr.headRefOid !== "string") {
    return refused("forge_unavailable", "GitHub returned an unexpected answer for the pull request.");
  }
  if (pr.headRefOid !== action.headSha) {
    return refused("pull_request_mismatch", "The pull request's head is no longer the approved head.");
  }
  if (pr.state === "MERGED") return { outcome: "already_merged" };
  if (pr.state !== "OPEN") return refused("pull_request_mismatch", "The pull request is closed.");
  if (record(pr.mergeQueueEntry)) return { outcome: "already_queued" };
  const url = `https://github.com/${action.repository}/pull/${action.pullRequest}`;
  // The canonical approved command: pinned to the head, never --delete-branch.
  const merged = await gh(["pr", "merge", url, "--squash", "--match-head-commit", action.headSha]);
  if (merged.code === null) return { outcome: "enqueued" };
  if (merged.timedOut) return { outcome: "uncertain" };
  const failure = classifyGhFailure(merged);
  if (UNAVAILABLE_WORDS[failure]) return refused("forge_unavailable", `${UNAVAILABLE_WORDS[failure]} Nothing was enqueued.`);
  if (/head branch was modified|head commit .*does not match|expected head/iu.test(merged.stderr)) {
    return refused("pull_request_mismatch", "The pull request's head changed before the enqueue.");
  }
  return refused("forge_refused", "GitHub refused the enqueue (for example, the pull request is not mergeable yet); nothing was enqueued.");
}
