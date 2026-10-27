/**
 * Closing references in GitHub merges (#3713, protocol v240).
 *
 * A GitHub `pr_merge` snapshot declares the issues the merge is meant to close in
 * `intendedClosures`. Before the decision is created and again before it is armed, the child's
 * runner reports what GitHub would actually close (`github_merge_preflight`). The two must match:
 * an undeclared closure is the "This PR does not close #N" mistake that closed #3635, and a declared
 * one GitHub would not make leaves the approved snapshot describing a different merge.
 */
import type { PullRequestClosingReferenceCheck, PullRequestClosure } from "@wollipog/protocol";
import { CLOSING_REFERENCE_EXCERPT_MAX, canonicalIssueReference, compareIssueReferences } from "@wollipog/protocol";

/** Declared closures a snapshot may carry; a merge that closes more cannot be described exactly. */
export const INTENDED_CLOSURES_LIMIT = 100;
/** Issues a refusal names individually before summarizing the rest. */
const SHOWN = 5;

/** Sorted unique `owner/repo#N`; `#N` names an issue in `repository`. `undefined` when none are
 * declared (so earlier digests are unchanged), `null` when the value is not a list of issues. */
export function normalizeIntendedClosures(value: unknown, repository: string): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > INTENDED_CLOSURES_LIMIT) return null;
  const issues = value.map((item) => typeof item === "string" && item.length <= 512 ? canonicalIssueReference(item, repository) : null);
  if (issues.some((issue) => issue === null)) return null;
  const unique = [...new Set(issues as string[])].sort(compareIssueReferences);
  return unique.length ? unique : undefined;
}

/** The runner's report, rebuilt from its checked fields only, or null when anything is malformed. */
export function validClosingReferenceCheck(value: unknown): PullRequestClosingReferenceCheck | null {
  const check = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!check || !Number.isSafeInteger(check.checkedAt) || (check.checkedAt as number) < 1 ||
      !Array.isArray(check.closures) || check.closures.length > INTENDED_CLOSURES_LIMIT) return null;
  const closures: PullRequestClosure[] = [];
  for (const raw of check.closures) {
    const closure = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const sources = Array.isArray(closure?.sources) ? closure.sources : null;
    if (!closure || typeof closure.issue !== "string" || canonicalIssueReference(closure.issue) !== closure.issue ||
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

/** Why the closures GitHub would make differ from the declared ones, or null when they match. */
export function prMergeClosureMismatch(declared: readonly string[], closures: readonly PullRequestClosure[]): string | null {
  const actual = new Map(closures.map((closure) => [closure.issue, closure]));
  const undeclared = [...actual.keys()].filter((issue) => !declared.includes(issue));
  const unmade = declared.filter((issue) => !actual.has(issue));
  const sentences: string[] = [];
  if (undeclared.length) {
    sentences.push(`Merging this pull request would close ${undeclared.length === 1 ? "an issue" : "issues"} that intendedClosures does not list: ${
      named(undeclared, (issue) => {
        const closure = actual.get(issue)!;
        return closure.excerpt
          ? `${issue}, from the description: “${closure.excerpt}”`
          : `${issue}, which GitHub links to the pull request (from its description or its Development section)`;
      })}.`);
    sentences.push("GitHub closes an issue when close, fix or resolve, in any tense, comes directly before its reference, " +
      "even in a negated or hyphenated phrase such as “does not close #N” or “auto-close #N”.");
    sentences.push("Write “Refs #N” for an issue that must stay open, remove a link in the pull request's Development section, " +
      "or list the issue in intendedClosures if this merge should close it.");
  }
  if (unmade.length) {
    sentences.push(`intendedClosures lists ${named(unmade, (issue) => issue)}, but merging this pull request would not close ${
      unmade.length === 1 ? "it" : "them"}. Remove ${unmade.length === 1 ? "it" : "them"}, or add a closing reference to the description.`);
  }
  return sentences.length ? sentences.join(" ") : null;
}
