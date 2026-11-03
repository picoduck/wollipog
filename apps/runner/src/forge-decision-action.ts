/**
 * Wollipog-performed forge actions (#4067, protocol v278; see `@wollipog/protocol`
 * forge-decision-action). The control plane has already checked the approval, its authority and
 * its snapshot; this module performs exactly the one approved action through the child session's
 * own `gh` and `git` logins, after re-reading the forge, and reports a fixed outcome. Nothing
 * `gh` or `git` prints crosses back: every failure is a fixed code and sentence.
 *
 * - A branch deletion proves the pull request merged the approved head from the approved branch in
 *   the same repository, that no open pull request targets the branch, and that the remote tip is
 *   still the approved head, then pushes a compare-and-delete pinned to that head, so a tip that
 *   moves after the read is refused by the remote itself.
 * - An enqueue proves the pull request is open at the approved head, then runs the canonical
 *   `gh pr merge <url> --squash --match-head-commit <sha>`. A pull request already in the queue,
 *   or already merged at that head, is the approved action having taken effect.
 */
import type {
  AgentContext,
  ForgeDecisionAction,
  ForgeDecisionActionOutcome,
  ForgeDecisionActionRefusalReason,
} from "@wollipog/protocol";
import { forgeActionBranchName } from "@wollipog/protocol";
import { classifyGhFailure, type GhOutcome, type GhRunner } from "./campaign-forge-status.js";
import { runContextCommand } from "./context-command.js";
import { parseForgeRemote } from "./git-ops.js";

/** Runs `git` in the session's repository; same outcome shape as `GhRunner`. */
export type ForgeGitRunner = (args: string[]) => Promise<GhOutcome>;

const GIT_TIMEOUT_MS = 60_000;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
const SHA = /^[0-9a-f]{40}$/u;

export interface ForgeDecisionActionResult {
  outcome: ForgeDecisionActionOutcome;
  refusal?: { reason: ForgeDecisionActionRefusalReason; summary: string };
}

/** `git` in the session's agent context and repository, with its agent's environment, so the push
 * uses the same credentials the child's own push used. Never prompts. */
export function contextGitRunner(context: AgentContext, cwd: string, agentEnv: Record<string, string> = {}): ForgeGitRunner {
  return async (args) => {
    try {
      const { stdout, stderr } = await runContextCommand(context, "git", args, {
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...agentEnv, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", NO_COLOR: "1" },
      });
      return { stdout, stderr, code: null, timedOut: false };
    } catch (error) {
      const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown; signal?: unknown };
      return {
        stdout: typeof failure.stdout === "string" ? failure.stdout : "",
        stderr: typeof failure.stderr === "string" ? failure.stderr : String((error as Error)?.message ?? ""),
        code: typeof failure.code === "number" || typeof failure.code === "string" ? failure.code : 1,
        timedOut: failure.killed === true || typeof failure.signal === "string",
      };
    }
  };
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
  repository(owner:$owner,name:$name){ nameWithOwner
    pullRequest(number:$number){ number state headRefName headRefOid isCrossRepository mergeCommit{ oid } }
    ref(qualifiedName:$ref){ target{ oid } }
    pullRequests(states:OPEN, baseRefName:$branch, first:1){ totalCount }
  }
}`;

/** Whether `origin` (fetch and push) is the approved GitHub repository. */
async function originIsRepository(git: ForgeGitRunner, repository: string): Promise<boolean> {
  for (const args of [["remote", "get-url", "origin"], ["remote", "get-url", "--push", "origin"]]) {
    const outcome = await git(args);
    const remote = outcome.code === null ? parseForgeRemote(outcome.stdout) : null;
    if (remote?.provider !== "github" || remote.project.toLowerCase() !== repository.toLowerCase()) return false;
  }
  return true;
}

export async function executeBranchDeletion(
  action: Extract<ForgeDecisionAction, { kind: "branch_deletion" }>,
  gh: GhRunner,
  git: ForgeGitRunner,
): Promise<ForgeDecisionActionResult> {
  if (!REPOSITORY.test(action.repository) || !forgeActionBranchName(action.branch) || !Number.isSafeInteger(action.pullRequest) ||
      action.pullRequest < 1 || !SHA.test(action.headSha) || !SHA.test(action.mergeCommitSha)) {
    return refused("pull_request_mismatch", "The decision does not name a GitHub branch this runner can delete.");
  }
  const read = await readRepository(gh, DELETION_QUERY, action.repository, [
    ["number", String(action.pullRequest)], ["ref", `refs/heads/${action.branch}`], ["branch", action.branch],
  ]);
  if ("refusal" in read) return read.refusal;
  const pr = record(read.data.pullRequest);
  const ref = read.data.ref === null ? null : record(read.data.ref);
  const tip = ref ? record(ref.target)?.oid : null;
  const dependents = record(read.data.pullRequests)?.totalCount;
  if (!pr || pr.number !== action.pullRequest || (ref && typeof tip !== "string") || !Number.isSafeInteger(dependents)) {
    return refused("forge_unavailable", "GitHub returned an unexpected answer for the pull request.");
  }
  if (pr.state !== "MERGED" || pr.headRefName !== action.branch || pr.headRefOid !== action.headSha ||
      pr.isCrossRepository !== false || record(pr.mergeCommit)?.oid !== action.mergeCommitSha) {
    return refused("pull_request_mismatch", "The pull request did not merge the approved head from this branch with the approved merge commit.");
  }
  if ((dependents as number) > 0) {
    return refused("dependent_pull_request_open", "An open pull request targets this branch, so it was left alone.");
  }
  if (ref === null) return { outcome: "already_deleted" };
  if (tip !== action.headSha) {
    return refused("tip_moved", "The branch tip is no longer the approved merged head, so it was left alone.");
  }
  if (!await originIsRepository(git, action.repository)) {
    return refused("repository_mismatch", "The session's origin remote is not the approved repository.");
  }
  // The remote applies the lease atomically: the deletion happens only while the tip is the head.
  const pushed = await git(["push", "--porcelain", "--no-verify",
    `--force-with-lease=refs/heads/${action.branch}:${action.headSha}`, "origin", `:refs/heads/${action.branch}`]);
  if (pushed.code === null) return { outcome: "deleted" };
  if (pushed.timedOut) return { outcome: "uncertain" };
  const text = `${pushed.stdout}\n${pushed.stderr}`;
  if (/stale info|fetch first|non-fast-forward/iu.test(text)) {
    return refused("tip_moved", "The branch tip moved before the deletion, so it was left alone.");
  }
  if (/remote ref does not exist/iu.test(text)) return { outcome: "already_deleted" };
  if (/could not read Username|Authentication failed|Permission denied \(publickey\)|could not resolve host|unable to access|Connection (?:refused|reset|timed out)|Could not read from remote repository/iu.test(text)) {
    return refused("forge_unavailable", "The remote could not be reached or refused this session's credentials; nothing was deleted.");
  }
  return refused("forge_refused", "The remote refused the deletion (for example, a branch protection rule); nothing was deleted.");
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
