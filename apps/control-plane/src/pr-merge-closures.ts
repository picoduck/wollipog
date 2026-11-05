/**
 * Closing references in GitHub merges (#3713, protocol v242).
 *
 * A GitHub `pr_merge` snapshot declares the issues the merge is meant to close in
 * `intendedClosures`. Before the decision is created and again before it is armed, the child's
 * runner reports what GitHub would actually close (`github_merge_preflight`). The two must match:
 * an undeclared closure is the "This PR does not close #N" mistake that closed #3635, and a declared
 * one GitHub would not make leaves the approved snapshot describing a different merge.
 *
 * A GitLab merge (#3762, protocol v295) follows the same contract: its runner reports GitLab's
 * closing pattern on the description and GitLab's own `closes_issues` list
 * (`gitlab_merge_closures`), and its issues are named `host/group/project#N`.
 */
import type { PullRequestClosingReferenceCheck, PullRequestClosure } from "@wollipog/protocol";
import {
  CLOSING_REFERENCE_EXCERPT_MAX, campaignRepositoryLocation, canonicalGitLabIssueReference, canonicalIssueReference, compareIssueReferences,
} from "@wollipog/protocol";

/** Declared closures a snapshot may carry; a merge that closes more cannot be described exactly. */
export const INTENDED_CLOSURES_LIMIT = 100;
/** Issues a refusal names individually before summarizing the rest. */
const SHOWN = 5;

/** The canonical issue `value` names: `#N` is an issue in `repository`, whose forge decides the form. */
function canonicalClosure(value: string, repository: string | undefined): string | null {
  return repository !== undefined && campaignRepositoryLocation(repository)?.forge === "gitlab"
    ? canonicalGitLabIssueReference(value, repository)
    : canonicalIssueReference(value, repository);
}

/** Sorted unique `owner/repo#N` (or, for a GitLab project, `host/group/project#N`); `#N` names an
 * issue in `repository`. `undefined` when none are declared (so earlier digests are unchanged),
 * `null` when the value is not a list of issues. */
export function normalizeIntendedClosures(value: unknown, repository: string): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > INTENDED_CLOSURES_LIMIT) return null;
  const issues = value.map((item) => typeof item === "string" && item.length <= 512 ? canonicalClosure(item, repository) : null);
  if (issues.some((issue) => issue === null)) return null;
  const unique = [...new Set(issues as string[])].sort(compareIssueReferences);
  return unique.length ? unique : undefined;
}

/** The runner's report, rebuilt from its checked fields only, or null when anything is malformed.
 * A GitLab merge's report names issues on its project's instance (#3762). */
export function validClosingReferenceCheck(value: unknown, repository?: string): PullRequestClosingReferenceCheck | null {
  const gitlab = repository !== undefined && campaignRepositoryLocation(repository)?.forge === "gitlab";
  const check = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!check || !Number.isSafeInteger(check.checkedAt) || (check.checkedAt as number) < 1 ||
      !Array.isArray(check.closures) || check.closures.length > INTENDED_CLOSURES_LIMIT) return null;
  const closures: PullRequestClosure[] = [];
  for (const raw of check.closures) {
    const closure = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const sources = Array.isArray(closure?.sources) ? closure.sources : null;
    if (!closure || typeof closure.issue !== "string" ||
        (gitlab ? canonicalGitLabIssueReference(closure.issue, repository!) : canonicalIssueReference(closure.issue)) !== closure.issue ||
        !sources || sources.length < 1 || sources.length > 2 || new Set(sources).size !== sources.length ||
        sources.some((source) => source !== "description" && source !== "linked") ||
        sources.includes("description") !== (typeof closure.excerpt === "string") ||
        (closure.excerpt !== undefined && (typeof closure.excerpt !== "string" || !closure.excerpt ||
          closure.excerpt.length > CLOSING_REFERENCE_EXCERPT_MAX)) ||
        closures.some((known) => known.issue === closure.issue)) return null;
    closures.push({ issue: closure.issue, sources: [...sources] as PullRequestClosure["sources"],
      ...(typeof closure.excerpt === "string" ? { excerpt: closure.excerpt } : {}) });
  }
  return { checkedAt: check.checkedAt as number, closures: closures.sort((a, b) => compareIssueReferences(a.issue, b.issue)) };
}

function named(issues: string[], describe: (issue: string) => string): string {
  const shown = issues.slice(0, SHOWN).map(describe).join("; ");
  return issues.length > SHOWN ? `${shown}; and ${issues.length - SHOWN} more` : shown;
}

/** Why a Full Control merge closing issues outside the campaign's issue scope is refused (#4062).
 * Names every such issue, so the requester knows exactly which references to change. */
export function unscopedClosureRefusal(issues: readonly string[], forge: "github" | "gitlab" = "github"): string {
  return `Merging this ${forge === "gitlab" ? "merge request" : "pull request"} would close ${issues.length === 1 ? "an issue" : "issues"} outside this Full Control campaign's ` +
    `issue scope: ${issues.join(", ")}. The Orchestrator cannot approve a merge that closes an unscoped issue, so no decision was ` +
    "created. Write “Refs #N” for each such issue and remove it from intendedClosures, or have the Orchestrator add it with " +
    "request_campaign_issue_scope_change first; if that is refused, only the campaign owner can add it.";
}

/** Why the closures the forge would make differ from the declared ones, or null when they match. */
export function prMergeClosureMismatch(declared: readonly string[], closures: readonly PullRequestClosure[],
  forge: "github" | "gitlab" = "github"): string | null {
  const actual = new Map(closures.map((closure) => [closure.issue, closure]));
  const undeclared = [...actual.keys()].filter((issue) => !declared.includes(issue));
  const unmade = declared.filter((issue) => !actual.has(issue));
  const gitlab = forge === "gitlab";
  const merged = gitlab ? "merge request" : "pull request";
  const sentences: string[] = [];
  if (undeclared.length) {
    sentences.push(`Merging this ${merged} would close ${undeclared.length === 1 ? "an issue" : "issues"} that intendedClosures does not list: ${
      named(undeclared, (issue) => {
        const closure = actual.get(issue)!;
        return closure.excerpt
          ? `${issue}, from the description: “${closure.excerpt}”`
          : gitlab
            ? `${issue}, which GitLab reports the merge request closes (from its title, description or commits)`
            : `${issue}, which GitHub links to the pull request (from its description or its Development section)`;
      })}.`);
    sentences.push(gitlab
      ? "GitLab closes an issue when close, fix, resolve or implement, in any form including “closing” or “implements”, " +
        "comes before its reference, even in a negated sentence such as “does not close #N”, and one keyword closes every " +
        "reference in a list such as “Closes #1, #2 and #3”."
      : "GitHub closes an issue when close, fix or resolve, in any tense, comes directly before its reference, " +
        "even in a negated or hyphenated phrase such as “does not close #N” or “auto-close #N”.");
    sentences.push(gitlab
      ? "Write “Refs #N” for an issue that must stay open, in the title, description and commit messages, " +
        "or list the issue in intendedClosures if this merge should close it."
      : "Write “Refs #N” for an issue that must stay open, remove a link in the pull request's Development section, " +
        "or list the issue in intendedClosures if this merge should close it.");
  }
  if (unmade.length) {
    sentences.push(`intendedClosures lists ${named(unmade, (issue) => issue)}, but merging this ${merged} would not close ${
      unmade.length === 1 ? "it" : "them"}. Remove ${unmade.length === 1 ? "it" : "them"}, or add a closing reference to the description.`);
  }
  return sentences.length ? sentences.join(" ") : null;
}
