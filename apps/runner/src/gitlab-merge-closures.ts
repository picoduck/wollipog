/**
 * GitLab merge closures (#3762, protocol v295): before a GitLab `pr_merge` decision is requested or
 * armed, read the merge request through the child session's own `glab` login and report every issue
 * merging it would close. Read-only, always naming the host. Every failure is a fixed sentence,
 * never `glab` output.
 *
 * Two sources, either of which closes an issue: GitLab's default closing pattern on the description,
 * read by the matcher in `@wollipog/protocol` with the line it is on, and GitLab's own
 * `closes_issues` list, which also covers the title, the commits and an instance configured with a
 * different closing pattern. Where the two disagree, GitLab's list is what GitLab acts on, and the
 * description's extra matches are still reported: a false report costs a reworded sentence.
 */
import type { PullRequestClosingReferenceCheck, PullRequestClosure } from "@wollipog/protocol";
import { campaignRepositoryLocation, canonicalGitLabIssueReference, findGitLabClosingReferences } from "@wollipog/protocol";
import { classifyGlabFailure, type GlabRunner } from "./campaign-gitlab-status.js";
import { PULL_REQUEST_CLOSURE_LIMIT, pullRequestClosures } from "./github-merge-preflight.js";

/** GitLab's largest page; a full page may have more after it, so it is not checked. */
const CLOSES_ISSUES_PAGE = 100;

export type MergeRequestClosureInspection =
  | { ok: true; state: "opened" | "closed" | "merged" | "locked"; headSha: string; closures: PullRequestClosure[] }
  | { ok: false; reason: string };

export type GitLabMergeClosures =
  | { ok: true; check: PullRequestClosingReferenceCheck }
  | { ok: false; refusal: "stale_head" | "unavailable"; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Read one merge request's state, head and closures. `repository` is the project, named by host
 * and full namespace. */
export async function inspectMergeRequestClosures(
  repository: string, mergeRequest: number, glab: GlabRunner, signal?: AbortSignal,
): Promise<MergeRequestClosureInspection> {
  const location = campaignRepositoryLocation(repository);
  if (location?.forge !== "gitlab" || !Number.isSafeInteger(mergeRequest) || mergeRequest < 1) {
    return { ok: false, reason: "The decision does not name a GitLab merge request this runner can check." };
  }
  const host = location.host.toLowerCase();
  const path = `projects/${encodeURIComponent(location.project)}/merge_requests/${mergeRequest}`;
  const unexpected = { ok: false as const, reason: "GitLab returned an unexpected answer for the merge request." };
  const read = async (endpoint: string): Promise<{ value: unknown } | { ok: false; reason: string }> => {
    const outcome = await glab(["api", endpoint, "--hostname", host], signal);
    if (outcome.code !== null) {
      const words: Record<string, string> = {
        forge_cli_missing: "glab is not installed in this session's context.",
        forge_unauthenticated: `glab in this session's context is not signed in to ${host}.`,
        forge_unreachable: `${host} could not be reached.`,
        forge_rate_limited: `${host} rate-limited this glab login.`,
        forge_not_found: "GitLab has no such merge request or project, or this glab login cannot see it.",
      };
      return { ok: false, reason: words[classifyGlabFailure(outcome)] ?? "GitLab returned an error." };
    }
    try {
      return { value: JSON.parse(outcome.stdout) as unknown };
    } catch {
      return unexpected;
    }
  };

  const mrRead = await read(path);
  if (!("value" in mrRead)) return mrRead;
  const mr = record(mrRead.value);
  const description = mr?.description === null ? "" : mr?.description;
  if (!mr || mr.iid !== mergeRequest || typeof mr.sha !== "string" || !/^[0-9a-f]{40}$/iu.test(mr.sha) ||
      !["opened", "closed", "merged", "locked"].includes(mr.state as string) || typeof description !== "string") {
    return unexpected;
  }
  const listRead = await read(`${path}/closes_issues?per_page=${CLOSES_ISSUES_PAGE}`);
  if (!("value" in listRead)) return listRead;
  if (!Array.isArray(listRead.value)) return unexpected;
  if (listRead.value.length >= CLOSES_ISSUES_PAGE) {
    return { ok: false, reason: `GitLab reports at least ${CLOSES_ISSUES_PAGE} issues this merge request would close, more than this runner checks.` };
  }
  const linked: string[] = [];
  for (const raw of listRead.value) {
    const item = record(raw);
    // An external tracker's issue has no IID, and no GitLab issue this check can name.
    if (!item || !Number.isSafeInteger(item.iid) || (item.iid as number) < 1) {
      return { ok: false, reason: "GitLab reports an issue this merge request would close that is not a GitLab issue this runner can name." };
    }
    const full = record(item.references)?.full;
    const named = typeof full === "string" ? canonicalGitLabIssueReference(full, repository)
      : typeof item.web_url === "string" ? canonicalGitLabIssueReference(item.web_url, repository) : null;
    if (!named || !named.endsWith(`#${item.iid as number}`)) return unexpected;
    linked.push(named);
  }
  const closures = pullRequestClosures(description, repository, linked, findGitLabClosingReferences);
  if (closures.length > PULL_REQUEST_CLOSURE_LIMIT) {
    return { ok: false, reason: `The merge request would close more than ${PULL_REQUEST_CLOSURE_LIMIT} issues, more than this runner checks.` };
  }
  return { ok: true, state: mr.state as "opened" | "closed" | "merged" | "locked", headSha: mr.sha.toLowerCase(), closures };
}

export async function gitlabMergeClosures(
  request: { repository: string; pullRequest: number; headSha: string },
  glab: GlabRunner,
  now: () => number = Date.now,
): Promise<GitLabMergeClosures> {
  if (!/^[0-9a-f]{40}$/u.test(request.headSha)) {
    return { ok: false, refusal: "unavailable", reason: "The decision does not name a GitLab merge request this runner can check." };
  }
  const inspected = await inspectMergeRequestClosures(request.repository, request.pullRequest, glab);
  if (!inspected.ok) return { ok: false, refusal: "unavailable", reason: inspected.reason };
  if (inspected.state !== "opened") {
    const words = { merged: "already merged", closed: "closed", locked: "being merged already" } as const;
    return { ok: false, refusal: "stale_head", reason: `The merge request is ${words[inspected.state]}.` };
  }
  if (inspected.headSha !== request.headSha) {
    return { ok: false, refusal: "stale_head", reason: "The merge request's head is no longer the decision's head." };
  }
  return { ok: true, check: { checkedAt: now(), closures: inspected.closures } };
}
