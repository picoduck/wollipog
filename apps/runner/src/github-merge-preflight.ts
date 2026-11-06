/**
 * GitHub merge preflight (#3713, protocol v242): before a GitHub `pr_merge` decision is requested or
 * armed, read the pull request through the child session's own `gh` login and report every issue
 * merging it would close. Read-only. Every failure is a fixed sentence, never `gh` output.
 *
 * GitHub closes an issue on merge when the description puts a closing keyword before its reference
 * (whatever the sentence says, so "does not close #12" closes #12) or when the issue is linked by
 * hand. Both are read: the description through the measured matcher in `@wollipog/protocol`, with
 * the line it is on, and GitHub's own `closingIssuesReferences`. Either one alone is reported.
 * The title and commit messages are not: GitHub never links from a title, and a squash merge
 * through the merge queue left #3705 open although its squash commit said `Closes #3705`.
 */
import type { PullRequestChecksRead, PullRequestClosingReferenceCheck, PullRequestClosure } from "@wollipog/protocol";
import { compareIssueReferences, findClosingReferences } from "@wollipog/protocol";
import { classifyGhFailure, type GhRunner } from "./campaign-forge-status.js";

/** Closures one check reports at most; a pull request that would close more is not checked. */
export const PULL_REQUEST_CLOSURE_LIMIT = 100;

const QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ nameWithOwner
    pullRequest(number:$number){ number state headRefOid body
      closingIssuesReferences(first:100){ nodes{ number repository{ nameWithOwner } } pageInfo{ hasNextPage } }
    }
  }
}`;

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;

export type PullRequestClosureInspection =
  | { ok: true; state: "OPEN" | "CLOSED" | "MERGED"; headSha: string; closures: PullRequestClosure[] }
  | { ok: false; reason: string };

export type GithubMergePreflight =
  | { ok: true; check: PullRequestClosingReferenceCheck; checks?: PullRequestChecksRead }
  | { ok: false; refusal: "stale_head" | "unavailable"; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The issues a description and the forge's own list would close, one entry per issue, in issue
 * order. `find` reads the description: GitHub's keywords, or GitLab's closing pattern (#3762). */
export function pullRequestClosures(description: string, repository: string, linked: readonly string[],
  find: typeof findClosingReferences = findClosingReferences): PullRequestClosure[] {
  const closures = new Map<string, PullRequestClosure>();
  for (const found of find(description, repository)) {
    if (!closures.has(found.issue)) closures.set(found.issue, { issue: found.issue, sources: ["description"], excerpt: found.excerpt });
  }
  for (const issue of linked) {
    const known = closures.get(issue);
    if (!known) closures.set(issue, { issue, sources: ["linked"] });
    else if (!known.sources.includes("linked")) known.sources.push("linked");
  }
  return [...closures.values()].sort((a, b) => compareIssueReferences(a.issue, b.issue));
}

/** Read one pull request's state, head and closures. */
export async function inspectPullRequestClosures(
  repository: string, pullRequest: number, gh: GhRunner, signal?: AbortSignal,
): Promise<PullRequestClosureInspection> {
  if (!REPOSITORY.test(repository) || !Number.isSafeInteger(pullRequest) || pullRequest < 1) {
    return { ok: false, reason: "The decision does not name a GitHub pull request this runner can check." };
  }
  const [owner, name] = repository.split("/");
  const outcome = await gh(["api", "graphql", "--hostname", "github.com", "-f", `query=${QUERY}`,
    "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pullRequest}`], signal);
  if (outcome.code !== null) {
    const words: Record<string, string> = {
      forge_cli_missing: "gh is not installed in this session's context.",
      forge_unauthenticated: "gh in this session's context is not signed in to github.com.",
      forge_unreachable: "github.com could not be reached.",
      forge_rate_limited: "github.com rate-limited this gh login.",
    };
    return { ok: false, reason: words[classifyGhFailure(outcome)] ?? "GitHub returned an error." };
  }
  const unexpected = { ok: false as const, reason: "GitHub returned an unexpected answer for the pull request." };
  let data: Record<string, unknown> | null;
  try {
    const response = record(JSON.parse(outcome.stdout));
    data = response && !response.errors ? record(record(response.data)?.repository) : null;
  } catch {
    return unexpected;
  }
  const pr = record(data?.pullRequest);
  if (!data || typeof data.nameWithOwner !== "string" || data.nameWithOwner.toLowerCase() !== repository.toLowerCase()) return unexpected;
  if (data.pullRequest === null) return { ok: false, reason: "GitHub has no such pull request, or this gh login cannot see it." };
  const links = record(pr?.closingIssuesReferences);
  const nodes = Array.isArray(links?.nodes) ? links.nodes : null;
  if (!pr || pr.number !== pullRequest || typeof pr.headRefOid !== "string" || !/^[0-9a-f]{40}$/u.test(pr.headRefOid) ||
      !["OPEN", "CLOSED", "MERGED"].includes(pr.state as string) || typeof pr.body !== "string" ||
      !nodes || record(links!.pageInfo)?.hasNextPage !== false) {
    return unexpected;
  }
  const linked: string[] = [];
  for (const raw of nodes) {
    const node = record(raw);
    const owner = record(node?.repository)?.nameWithOwner;
    if (!node || !Number.isSafeInteger(node.number) || (node.number as number) < 1 || typeof owner !== "string" || !REPOSITORY.test(owner)) {
      return unexpected;
    }
    linked.push(`${owner.toLowerCase()}#${node.number as number}`);
  }
  const closures = pullRequestClosures(pr.body, repository, linked);
  if (closures.length > PULL_REQUEST_CLOSURE_LIMIT) {
    return { ok: false, reason: `The pull request would close more than ${PULL_REQUEST_CLOSURE_LIMIT} issues, more than this runner checks.` };
  }
  return { ok: true, state: pr.state as "OPEN" | "CLOSED" | "MERGED", headSha: pr.headRefOid, closures };
}

/** Checks one read reports at most; a head with more is not checked. */
export const PULL_REQUEST_CHECKS_LIMIT = 100;

const CHECKS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ nameWithOwner
    pullRequest(number:$number){ number headRefOid mergeStateStatus
      commits(last:1){ nodes{ commit{ oid statusCheckRollup{
        contexts(first:${PULL_REQUEST_CHECKS_LIMIT}){ pageInfo{ hasNextPage } nodes{ __typename
          ... on CheckRun{ name status conclusion isRequired(pullRequestNumber:$number) }
          ... on StatusContext{ context state isRequired(pullRequestNumber:$number) }
        } }
      } } } }
    }
  }
}`;

// GitHub's CheckConclusionState values that count as passing, as `summarizeCheckRollup` reads them.
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** v315 (#4119): read every check reported for the pull request's head, how many of them GitHub
 * marks required, and whether its merge state is clean. Fails closed: an unexpected answer, another
 * head, or more checks than one page holds proves nothing. */
export async function inspectPullRequestChecks(
  repository: string, pullRequest: number, headSha: string, gh: GhRunner, signal?: AbortSignal,
): Promise<{ ok: true; checks: PullRequestChecksRead } | { ok: false; reason: string }> {
  if (!REPOSITORY.test(repository) || !Number.isSafeInteger(pullRequest) || pullRequest < 1) {
    return { ok: false, reason: "The decision does not name a GitHub pull request this runner can check." };
  }
  const [owner, name] = repository.split("/");
  const outcome = await gh(["api", "graphql", "--hostname", "github.com", "-f", `query=${CHECKS_QUERY}`,
    "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pullRequest}`], signal);
  if (outcome.code !== null) return { ok: false, reason: "GitHub could not be read for the pull request's checks." };
  const unexpected = { ok: false as const, reason: "GitHub returned an unexpected answer for the pull request's checks." };
  let data: Record<string, unknown> | null;
  try {
    const response = record(JSON.parse(outcome.stdout));
    data = response && !response.errors ? record(record(response.data)?.repository) : null;
  } catch {
    return unexpected;
  }
  const pr = record(data?.pullRequest);
  if (!data || typeof data.nameWithOwner !== "string" || data.nameWithOwner.toLowerCase() !== repository.toLowerCase() ||
      !pr || pr.number !== pullRequest || typeof pr.mergeStateStatus !== "string") return unexpected;
  if (pr.headRefOid !== headSha) return { ok: false, reason: "The pull request's head is no longer the decision's head." };
  const commits = record(pr.commits)?.nodes;
  const commit = Array.isArray(commits) && commits.length === 1 ? record(record(commits[0])?.commit) : null;
  if (!commit || commit.oid !== headSha) return unexpected;
  const rollup = commit.statusCheckRollup === null ? null : record(commit.statusCheckRollup);
  if (commit.statusCheckRollup !== null && !rollup) return unexpected;
  const contexts = rollup ? record(rollup.contexts) : null;
  const nodes = rollup ? contexts?.nodes : [];
  if (!Array.isArray(nodes) || (rollup && typeof record(contexts?.pageInfo)?.hasNextPage !== "boolean")) return unexpected;
  if (rollup && record(contexts!.pageInfo)!.hasNextPage !== false) {
    return { ok: false, reason: `The pull request's head reports more than ${PULL_REQUEST_CHECKS_LIMIT} checks, more than this runner checks.` };
  }
  const reported: PullRequestChecksRead["reported"] = [];
  let required = 0;
  for (const raw of nodes) {
    const node = record(raw);
    const checkName = node?.__typename === "CheckRun" ? node.name : node?.__typename === "StatusContext" ? node.context : undefined;
    if (!node || typeof checkName !== "string" || checkName.length < 1 || checkName.length > 256 || typeof node.isRequired !== "boolean") return unexpected;
    if (node.isRequired) required += 1;
    const state = node.__typename === "StatusContext"
      ? node.state === "SUCCESS" ? "passed" : node.state === "FAILURE" || node.state === "ERROR" ? "failing" : "pending"
      : node.status !== "COMPLETED" ? "pending" : PASSING_CONCLUSIONS.has(node.conclusion as string) ? "passed" : "failing";
    reported.push({ name: checkName, state });
  }
  return { ok: true, checks: { required, reported, clean: pr.mergeStateStatus === "CLEAN" } };
}

export async function githubMergePreflight(
  request: { repository: string; pullRequest: number; headSha: string; checks?: true },
  gh: GhRunner,
  now: () => number = Date.now,
): Promise<GithubMergePreflight> {
  if (!/^[0-9a-f]{40}$/u.test(request.headSha)) {
    return { ok: false, refusal: "unavailable", reason: "The decision does not name a GitHub pull request this runner can check." };
  }
  const inspected = await inspectPullRequestClosures(request.repository, request.pullRequest, gh);
  if (!inspected.ok) return { ok: false, refusal: "unavailable", reason: inspected.reason };
  if (inspected.state !== "OPEN") {
    return { ok: false, refusal: "stale_head", reason: `The pull request is already ${inspected.state === "MERGED" ? "merged" : "closed"}.` };
  }
  if (inspected.headSha !== request.headSha) {
    return { ok: false, refusal: "stale_head", reason: "The pull request's head is no longer the decision's head." };
  }
  const check = { checkedAt: now(), closures: inspected.closures };
  if (request.checks !== true) return { ok: true, check };
  const checks = await inspectPullRequestChecks(request.repository, request.pullRequest, request.headSha, gh);
  return checks.ok ? { ok: true, check, checks: checks.checks } : { ok: false, refusal: "unavailable", reason: checks.reason };
}
