/**
 * GitHub merge preflight (#3713, protocol v240): before a GitHub `pr_merge` decision is requested or
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
import type { PullRequestClosingReferenceCheck, PullRequestClosure } from "@wollipog/protocol";
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
  | { ok: true; check: PullRequestClosingReferenceCheck }
  | { ok: false; refusal: "stale_head" | "unavailable"; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The issues a description and GitHub's links would close, one entry per issue, in issue order. */
export function pullRequestClosures(description: string, repository: string, linked: readonly string[]): PullRequestClosure[] {
  const closures = new Map<string, PullRequestClosure>();
  for (const found of findClosingReferences(description, repository)) {
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

export async function githubMergePreflight(
  request: { repository: string; pullRequest: number; headSha: string },
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
  return { ok: true, check: { checkedAt: now(), closures: inspected.closures } };
}
