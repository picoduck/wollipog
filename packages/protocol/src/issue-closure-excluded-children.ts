/**
 * The live campaign children an issue closure leaves out of its binding (#3237), with why.
 *
 * Since #3084 an issue-closure approval binds only the children whose work can bear on the issue:
 * a child the campaign work ledger proves unrelated is excluded, so its activity does not revoke
 * the approval. The snapshot records each excluded child and the ledger facts that excluded it, so
 * whoever approves can check that input. The list is read-only information: it stays outside the
 * approval's resource digest, and a child's activity alone never changes it. A child moving between
 * the bound and excluded sets still changes the bound list, which is what revokes a stale approval.
 *
 * The reason holds ledger facts only, never text a child wrote: the issues its attempted work items
 * have ever tracked, how many of those items never tracked one, and how many items it reaches only
 * through follow-up lineage. The approval card turns them into a sentence.
 */

/** The most excluded children a snapshot lists, as for the bound children. */
export const ISSUE_CLOSURE_EXCLUDED_CHILDREN_MAX = 100;
/** The most attempted issues an exclusion reason names; `attemptedIssueCount` keeps the total. */
export const ISSUE_CLOSURE_EXCLUSION_ISSUES_MAX = 20;

export interface IssueClosureExclusionReason {
  /** Every issue the child's attempted work items have ever tracked, sorted by repository then
   * number, at most {@link ISSUE_CLOSURE_EXCLUSION_ISSUES_MAX}. */
  attemptedIssues: Array<{ repository: string; number: number }>;
  /** How many distinct issues those items have ever tracked, including any beyond the list. */
  attemptedIssueCount: number;
  /** How many attempted work items have never tracked an issue. */
  attemptedWithoutIssue: number;
  /** How many work items the child reaches only through follow-up lineage. None of them has ever
   * tracked the issue being closed either, or the child would not be excluded. */
  linkedWorkItems: number;
}

export interface IssueClosureExcludedChild {
  sessionId: string;
  /** The child's session title as recorded at request time. Untrusted text: render it as text. */
  title: string;
  reason: IssueClosureExclusionReason;
}

const bounded = (value: unknown, max: number): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= max && !/[\0-\u001f\u007f]/u.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function normalizeReason(value: unknown): IssueClosureExclusionReason | null {
  if (!record(value) || !Array.isArray(value.attemptedIssues) || value.attemptedIssues.length > ISSUE_CLOSURE_EXCLUSION_ISSUES_MAX ||
      !count(value.attemptedIssueCount) || value.attemptedIssueCount < value.attemptedIssues.length ||
      !count(value.attemptedWithoutIssue) || !count(value.linkedWorkItems)) return null;
  const attemptedIssues: IssueClosureExclusionReason["attemptedIssues"] = [];
  for (const issue of value.attemptedIssues) {
    if (!record(issue) || !bounded(issue.repository, 256) || !Number.isSafeInteger(issue.number) || (issue.number as number) < 1) return null;
    attemptedIssues.push({ repository: issue.repository, number: issue.number as number });
  }
  return { attemptedIssues, attemptedIssueCount: value.attemptedIssueCount, attemptedWithoutIssue: value.attemptedWithoutIssue,
    linkedWorkItems: value.linkedWorkItems };
}

/** A received or stored excluded list, rebuilt canonically; null when it is not a bounded,
 * duplicate-free list. */
export function normalizeIssueClosureExcludedChildren(value: unknown): IssueClosureExcludedChild[] | null {
  if (!Array.isArray(value) || value.length > ISSUE_CLOSURE_EXCLUDED_CHILDREN_MAX) return null;
  const children: IssueClosureExcludedChild[] = [];
  const seen = new Set<string>();
  for (const child of value) {
    if (!record(child) || !bounded(child.sessionId, 256) || seen.has(child.sessionId) || typeof child.title !== "string" ||
        !child.title || child.title.length > 1024 || child.title.includes("\0")) return null;
    const reason = normalizeReason(child.reason);
    if (!reason) return null;
    seen.add(child.sessionId);
    children.push({ sessionId: child.sessionId, title: child.title, reason });
  }
  return children;
}

function list(items: string[], conjunction: "and" | "or"): string {
  return items.length < 3 ? items.join(` ${conjunction} `) : `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

/** The reason as one sentence, for the closure of an issue in `repository`. Issues of that
 * repository read `#N`; others are qualified. */
export function issueClosureExclusionReasonText(reason: IssueClosureExclusionReason, repository: string): string {
  const own = repository.toLowerCase();
  const subjects = reason.attemptedIssues.map((issue) =>
    issue.repository.toLowerCase() === own ? `#${issue.number}` : `${issue.repository}#${issue.number}`);
  const more = reason.attemptedIssueCount - reason.attemptedIssues.length;
  if (more > 0) subjects.push(`${more} more issue${more === 1 ? "" : "s"}`);
  if (reason.attemptedWithoutIssue > 0) {
    subjects.push(reason.attemptedWithoutIssue === 1 ? "a work item without an issue" : `${reason.attemptedWithoutIssue} work items without an issue`);
  }
  const links = reason.linkedWorkItems === 0 ? "no follow-up links"
    : `${reason.linkedWorkItems} follow-up-linked work item${reason.linkedWorkItems === 1 ? "" : "s"} that never tracked this issue either`;
  if (!subjects.length) return `No recorded work-item attempt has ever tracked this issue, and its work has ${links}.`;
  const single = subjects.length === 1 && more <= 0 && reason.attemptedWithoutIssue <= 1;
  return single
    ? `Every work-item attempt is on ${subjects[0]}, which has never tracked this issue and has ${links}.`
    : `Every work-item attempt is on ${list(subjects, "or")}, none of which has ever tracked this issue, and that work has ${links}.`;
}
