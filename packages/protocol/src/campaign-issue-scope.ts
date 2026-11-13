import type { CampaignIssueScope, CampaignIssueScopeRepositoryChange, CampaignIssueScopeSnapshot } from "./index.js";
import { validScopeProposal, type CampaignScopeProposal } from "./scope-proposal.js";
import { campaignRepositoryLocation, type CampaignIssueRef } from "./campaign-work-ledger.js";

/** The most issues one campaign scope holds, across all of its repositories (#4118). */
export const CAMPAIGN_ISSUE_SCOPE_MAX = 100;

export function boundedIssueNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= CAMPAIGN_ISSUE_SCOPE_MAX && value.every((n) => Number.isSafeInteger(n) && n > 0) && new Set(value).size === value.length;
}

const byIssue = (a: CampaignIssueRef, b: CampaignIssueRef) =>
  a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : a.number - b.number;

/** Repository-qualified issues in canonical form: lower-case repositories, sorted by repository
 * then number, each pair once. Null when any entry is malformed or the list exceeds the bound.
 * The same number in two repositories is two entries with separate authority. */
export function canonicalCampaignIssues(value: unknown): CampaignIssueRef[] | null {
  if (!Array.isArray(value) || value.length > CAMPAIGN_ISSUE_SCOPE_MAX) return null;
  const seen = new Set<string>();
  const issues: CampaignIssueRef[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => key !== "repository" && key !== "number") ||
        typeof raw.repository !== "string" || !campaignRepositoryLocation(raw.repository) ||
        !Number.isSafeInteger(raw.number) || raw.number < 1) return null;
    const issue = { repository: raw.repository.toLowerCase(), number: raw.number as number };
    const key = `${issue.repository}#${issue.number}`;
    if (seen.has(key)) return null;
    seen.add(key);
    issues.push(issue);
  }
  return issues.sort(byIssue);
}

/** A scope's repository-qualified issues (#4118). A scope stored before #4118 holds only the
 * launch repository's numbers, and reads as those numbers in that repository. */
export function campaignScopeIssues(scope: Pick<CampaignIssueScope, "repository" | "issueNumbers" | "issues">): CampaignIssueRef[] {
  return scope.issues ? scope.issues.map((issue) => ({ ...issue }))
    : scope.issueNumbers.map((number) => ({ repository: scope.repository.toLowerCase(), number })).sort(byIssue);
}

/** The scope's numbers in one repository, ascending. */
export function campaignScopeNumbers(scope: Pick<CampaignIssueScope, "repository" | "issueNumbers" | "issues">, repository: string): number[] {
  const wanted = repository.toLowerCase();
  return campaignScopeIssues(scope).filter((issue) => issue.repository === wanted).map((issue) => issue.number).sort((a, b) => a - b);
}

/** Whether the scope authorizes this exact repository-qualified issue. */
export function campaignScopeHolds(scope: Pick<CampaignIssueScope, "repository" | "issueNumbers" | "issues">, issue: CampaignIssueRef): boolean {
  const repository = issue.repository.toLowerCase();
  return campaignScopeIssues(scope).some((held) => held.repository === repository && held.number === issue.number);
}

/** A scope holding exactly `issues`, with `issueNumbers` derived for its launch `repository`. */
export function campaignScopeWithIssues<T extends CampaignIssueScope>(scope: T, issues: readonly CampaignIssueRef[]): T {
  const canonical = canonicalCampaignIssues(issues);
  if (!canonical) throw new Error("Campaign issue scope holds a malformed or oversized issue list");
  const repository = scope.repository.toLowerCase();
  return { ...scope, issueNumbers: canonical.filter((issue) => issue.repository === repository).map((issue) => issue.number), issues: canonical };
}

/** The part of a scope one runner stores and checks (#4118): its own Location's repository and
 * that repository's numbers, in the shape runners read before #4118. For the launch repository of
 * a one-repository scope this is the stored scope without `issues`, exactly as before. */
export function campaignScopeForRepository(scope: CampaignIssueScope, repository: string): CampaignIssueScope {
  const { issues: _issues, ...rest } = scope;
  return { ...rest, repository: repository.toLowerCase(), issueNumbers: campaignScopeNumbers(scope, repository) };
}

/** Every repository part of a scope change: the launch repository first, then the others. */
export function campaignScopeChangeGroups(snapshot: Pick<CampaignIssueScopeSnapshot, "repository" | "before" | "additions" | "removals" | "otherRepositories">): CampaignIssueScopeRepositoryChange[] {
  return [{ repository: snapshot.repository, before: [...snapshot.before], additions: [...snapshot.additions], removals: [...snapshot.removals] },
    ...(snapshot.otherRepositories ?? []).map((group) => ({ ...group, before: [...group.before], additions: [...group.additions], removals: [...group.removals] }))];
}

/** The repository-qualified issues a scope change ends with. */
export function campaignScopeChangeResult(snapshot: Pick<CampaignIssueScopeSnapshot, "repository" | "before" | "additions" | "removals" | "otherRepositories">): CampaignIssueRef[] {
  return campaignScopeChangeGroups(snapshot).flatMap((group) => [...group.before.filter((n) => !group.removals.includes(n)), ...group.additions]
    .map((number) => ({ repository: group.repository, number }))).sort(byIssue);
}

/** The repository-qualified issues a scope change starts from. */
export function campaignScopeChangeBefore(snapshot: Pick<CampaignIssueScopeSnapshot, "repository" | "before" | "additions" | "removals" | "otherRepositories">): CampaignIssueRef[] {
  return campaignScopeChangeGroups(snapshot).flatMap((group) => group.before.map((number) => ({ repository: group.repository, number }))).sort(byIssue);
}

/** Validates one repository's part of a scope change, as the launch repository's is validated. */
function validScopeChangeGroup(group: { before: unknown; additions: unknown; removals: unknown }): boolean {
  return boundedIssueNumbers(group.before) && boundedIssueNumbers(group.additions) && boundedIssueNumbers(group.removals) &&
    !group.additions.some((n) => (group.before as number[]).includes(n)) && !group.removals.some((n) => !(group.before as number[]).includes(n));
}

/** Whether `url` is the exact web address of issue (or pull/merge request) `number` in a campaign
 * repository (#3539). GitHub: `https://github.com/<repository>/issues/<n>` (`/pull/<n>`), exactly.
 * GitLab: `http(s)://<host>/<project>/-/issues/<n>` (`/-/merge_requests/<n>`), with the host (and
 * port) exactly as the repository names it in lower case and the project compared case-insensitively. */
export function campaignIssueForgeUrl(url: unknown, repository: string, kind: "issue" | "change", number: number): boolean {
  const location = campaignRepositoryLocation(repository);
  if (!location || typeof url !== "string" || !Number.isSafeInteger(number) || number < 1) return false;
  if (location.forge === "github") return url === `https://github.com/${repository}/${kind === "issue" ? "issues" : "pull"}/${number}`;
  const match = /^https?:\/\/([^/?#@\s]+)\/([^?#\s]+)\/-\/(issues|merge_requests)\/([1-9][0-9]*)$/u.exec(url);
  return Boolean(match && match[1] === location.host.toLowerCase() && match[2]!.toLowerCase() === location.project.toLowerCase() &&
    match[3] === (kind === "issue" ? "issues" : "merge_requests") && match[4] === String(number));
}

/** Only a leading issue in an explicitly named member checklist is a candidate. Nothing here grants authority.
 * On GitLab (#3539) a member is `#N` or `http(s)://<host>/<project>/-/issues/N` of the same project;
 * GitLab epics, issue links and work-item children are never read. */
export function epicChecklistMembers(body: string, repository: string): number[] {
  if (body.length > 65536) throw new Error("Epic body exceeds the bounded membership inspection limit");
  const location = campaignRepositoryLocation(repository);
  const gitlab = location?.forge === "gitlab" ? location : null;
  const members = new Set<number>();
  let memberSection = false;
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/u.exec(line);
    if (heading) memberSection = /^(?:units|members|child issues|sub-issues|implementation issues)$/iu.test(heading[1]!.trim());
    if (!memberSection) continue;
    let number: number;
    if (gitlab) {
      const row = /^\s*[-*]\s+\[[ xX]\]\s+(?:#([1-9][0-9]*)\b|https?:\/\/([^\s/?#@]+)\/([^\s?#]+?)\/-\/issues\/([1-9][0-9]*)\b)/u.exec(line);
      if (!row || (row[2] !== undefined && (row[2].toLowerCase() !== gitlab.host.toLowerCase() || row[3]!.toLowerCase() !== gitlab.project.toLowerCase()))) continue;
      number = Number(row[1] ?? row[4]);
    } else {
      const row = /^\s*[-*]\s+\[[ xX]\]\s+(?:#([1-9][0-9]*)\b|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9][0-9]*)\b)/u.exec(line);
      if (!row || (row[2] && row[2].toLowerCase() !== repository.toLowerCase())) continue;
      number = Number(row[1] ?? row[3]);
    }
    if (!Number.isSafeInteger(number)) throw new Error("Epic contains an invalid member issue number");
    members.add(number);
    if (members.size > 99) throw new Error("Epic scope exceeds 100 issues; select a smaller explicit scope");
  }
  return [...members].sort((a, b) => a - b);
}

/** A proposal adds issues only, and lists exactly each repository's additions: an issue with no
 * `repository` is the launch repository's, and one that names it is a separate entry (#4118). */
function proposalMatchesAdditions(proposal: CampaignScopeProposal, launch: string, additions: readonly number[], removals: readonly number[],
  others: readonly CampaignIssueScopeRepositoryChange[]): boolean {
  if (removals.length || others.some((group) => group.removals.length)) return false;
  const listed = (repository: string) => proposal.issues.filter((issue) => (issue.repository ?? launch) === repository).map((issue) => issue.number).sort((a, b) => a - b);
  const groups = [{ repository: launch, additions }, ...others];
  return proposal.issues.every((issue) => groups.some((group) => group.repository === (issue.repository ?? launch))) &&
    proposal.issues.every((issue) => issue.repository !== launch) &&
    groups.every((group) => JSON.stringify(listed(group.repository)) === JSON.stringify([...group.additions].sort((a, b) => a - b)));
}

export function normalizeCampaignIssueScopeSnapshot(input: Record<string, unknown>): CampaignIssueScopeSnapshot | null {
  if (!validIssueAdmission(input.issueAdmission) || !validIssueLineage(input.lineage) || !validScopeGrantReview(input.grantReview) ||
      !validSelectionReview(input.selectionReview) || !validScopeOwnerReview(input.ownerReview) || !validScopeProposal(input.scopeProposal)) return null;
  // Only an owner-routed all proposal may also carry the exact ceiling increase it asks the
  // owner to authorize. Other proposals never mix review kinds; only admitted ones carry admission.
  const proposal = input.scopeProposal as CampaignScopeProposal | undefined;
  const ceilingReview = proposal?.route === "owner" && proposal.requestedCount === "all" &&
    (input.ownerReview as CampaignIssueScopeSnapshot["ownerReview"])?.cause === "lineage_missing" &&
    (input.ownerReview as CampaignIssueScopeSnapshot["ownerReview"])?.maxIssuesIncrease !== undefined;
  if (proposal && (input.grantReview !== undefined || input.selectionReview !== undefined || (input.ownerReview !== undefined && !ceilingReview) ||
      input.lineage !== undefined || (proposal.route === "admitted") !== (input.issueAdmission !== undefined))) return null;
  // An owner review never carries admission or grant review. Its cause constrains retained lineage (#4333).
  if (input.ownerReview !== undefined && (input.issueAdmission !== undefined || input.grantReview !== undefined ||
      input.selectionReview !== undefined)) return null;
  if (input.ownerReview !== undefined) {
    const cause = (input.ownerReview as CampaignIssueScopeSnapshot["ownerReview"])!.cause;
    const kind = (input.lineage as CampaignIssueScopeSnapshot["lineage"])?.kind;
    if (cause === "lineage_missing" ? kind !== undefined
      : cause === "epic_not_authorized" ? kind !== "epic"
      : cause === "selection_not_granted" ? kind !== "selection"
      : kind !== "follow_up") return null;
  }
  if (input.verifiedPublications !== undefined && (!Array.isArray(input.verifiedPublications) || input.verifiedPublications.length > 100 ||
      input.verifiedPublications.some((p) => !p || typeof p !== "object" || Object.keys(p).length !== 2 || typeof p.publicationOccurrenceId !== "string" ||
        !p.publicationOccurrenceId || p.publicationOccurrenceId.length > 256 || !Number.isSafeInteger(p.issue) || p.issue < 1 ||
        // The published issue is an addition of the launch repository or of another one (#4119).
        !(Array.isArray(input.additions) && input.additions.includes(p.issue) || Array.isArray(input.otherRepositories) &&
          input.otherRepositories.some((group: { additions?: unknown }) => Array.isArray(group?.additions) && group.additions.includes(p.issue)))) ||
      new Set(input.verifiedPublications.map((p) => p.publicationOccurrenceId)).size !== input.verifiedPublications.length)) return null;
  if (typeof input.repository !== "string" || !campaignRepositoryLocation(input.repository)) return null;
  const launch = input.repository.toLowerCase();
  // Each other repository appears once, never as the launch repository, with a valid change.
  const others: CampaignIssueScopeRepositoryChange[] = [];
  if (input.otherRepositories !== undefined) {
    if (!Array.isArray(input.otherRepositories) || !input.otherRepositories.length || input.otherRepositories.length > 50) return null;
    for (const raw of input.otherRepositories) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
          Object.keys(raw).some((key) => !["repository", "before", "additions", "removals"].includes(key)) ||
          typeof raw.repository !== "string" || !campaignRepositoryLocation(raw.repository) || !validScopeChangeGroup(raw)) return null;
      const repository = raw.repository.toLowerCase();
      if (repository === launch || others.some((group) => group.repository === repository)) return null;
      others.push({ repository, before: [...raw.before].sort((a, b) => a - b), additions: [...raw.additions].sort((a, b) => a - b),
        removals: [...raw.removals].sort((a, b) => a - b) });
    }
    others.sort((a, b) => a.repository < b.repository ? -1 : 1);
  }
  const changes = others.reduce((total, group) => total + group.additions.length + group.removals.length, 0);
  const after = others.reduce((total, group) => total + group.before.length + group.additions.length - group.removals.length, 0);
  if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0 ||
      !validScopeChangeGroup(input as { before: unknown; additions: unknown; removals: unknown }) ||
      !boundedIssueNumbers(input.before) || !boundedIssueNumbers(input.additions) || !boundedIssueNumbers(input.removals) ||
      // Only an initial proposal may admit no issues: it opens dispatch for work that needs none.
      (!input.additions.length && !input.removals.length && !changes && !proposal?.initial) ||
      // A proposal's issues are exactly the additions, each in its own repository (#4118).
      (proposal && !proposalMatchesAdditions(proposal, launch, input.additions as number[], input.removals as number[], others)) ||
      input.before.length + input.additions.length - input.removals.length + after > CAMPAIGN_ISSUE_SCOPE_MAX ||
      typeof input.explanation !== "string" || !input.explanation.trim() || input.explanation.length > 4000 ||
      !Array.isArray(input.affectedAssignments) || input.affectedAssignments.length > 100 ||
      !Array.isArray(input.affectedDecisions) || input.affectedDecisions.length > 1000 ||
      input.affectedDecisions.some((id) => typeof id !== "string" || !id || id.length > 256)) return null;
  const activeChildren: CampaignIssueScopeSnapshot["activeChildren"] = [];
  if (input.activeChildren !== undefined) {
    if (!Array.isArray(input.activeChildren) || input.activeChildren.length > 100) return null;
    for (const raw of input.activeChildren) {
      if (!raw || typeof raw !== "object" || typeof raw.sessionId !== "string" || !raw.sessionId || raw.sessionId.length > 256 ||
          typeof raw.title !== "string" || !raw.title || raw.title.length > 1024 || typeof raw.assignmentDigest !== "string" || !/^[0-9a-f]{64}$/u.test(raw.assignmentDigest)) return null;
      activeChildren.push({sessionId:raw.sessionId,title:raw.title,assignmentDigest:raw.assignmentDigest});
    }
  }
  const affectedAssignments: CampaignIssueScopeSnapshot["affectedAssignments"] = [];
  for (const raw of input.affectedAssignments) {
    if (!raw || typeof raw !== "object" || typeof raw.sessionId !== "string" || !raw.sessionId || raw.sessionId.length > 256 ||
        !Number.isSafeInteger(raw.issue) || raw.issue < 1) return null;
    // Only an assignment in another repository names it; the launch repository's stays implicit.
    if (raw.repository !== undefined && (typeof raw.repository !== "string" ||
        !others.some((group) => group.repository === raw.repository.toLowerCase()))) return null;
    affectedAssignments.push({ sessionId: raw.sessionId, issue: raw.issue,
      ...(raw.repository === undefined ? {} : { repository: (raw.repository as string).toLowerCase() }) });
  }
  return { category: "campaign_issue_scope", repository: launch, expectedRevision: input.expectedRevision as number,
    before: [...input.before].sort((a,b) => a-b), additions: [...input.additions].sort((a,b) => a-b), removals: [...input.removals].sort((a,b) => a-b),
    ...(others.length ? { otherRepositories: others } : {}),
    explanation: input.explanation, affectedAssignments, activeChildren, affectedDecisions: [...input.affectedDecisions] as string[],
    ...(input.lineage === undefined ? {} : { lineage: structuredClone(input.lineage) as CampaignIssueScopeSnapshot["lineage"] }),
    ...(input.issueAdmission === undefined ? {} : { issueAdmission: structuredClone(input.issueAdmission) as CampaignIssueScopeSnapshot["issueAdmission"] }),
    ...(input.verifiedPublications === undefined ? {} : { verifiedPublications: structuredClone(input.verifiedPublications) as CampaignIssueScopeSnapshot["verifiedPublications"] }),
    ...(input.grantReview === undefined ? {} : { grantReview: structuredClone(input.grantReview) as CampaignIssueScopeSnapshot["grantReview"] }),
    ...(input.selectionReview === undefined ? {} : { selectionReview: structuredClone(input.selectionReview) as CampaignIssueScopeSnapshot["selectionReview"] }),
    ...(input.ownerReview === undefined ? {} : { ownerReview: structuredClone(input.ownerReview) as CampaignIssueScopeSnapshot["ownerReview"] }),
    ...(proposal === undefined ? {} : { scopeProposal: structuredClone(proposal) }) };
}

export function validIssueAdmission(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const p = v.publicationAuthority as Record<string, unknown> | undefined;
  const r = v.relatedness as Record<string, unknown> | undefined;
  const related = r === undefined || Boolean(r && typeof r === "object" &&
    (r.basis === "decision_model" && Object.keys(r).length === 1 ||
     r.basis === "failed_campaign_run" && Object.keys(r).length === 8 &&
     typeof r.repository === "string" && /^[\w.-]+\/[\w.-]+$/u.test(r.repository) &&
     Number.isSafeInteger(r.pullRequest) && (r.pullRequest as number) > 0 &&
     Number.isSafeInteger(r.runId) && (r.runId as number) > 0 &&
     Number.isSafeInteger(r.jobId) && (r.jobId as number) > 0 &&
     Number.isSafeInteger(r.checkRunId) && (r.checkRunId as number) > 0 &&
     typeof r.checkName === "string" && r.checkName.trim().length > 0 && r.checkName.length <= 512 &&
     typeof r.headSha === "string" && /^[0-9a-f]{40}$/u.test(r.headSha)));
  return related && Object.keys(v).every((key) => ["boundaryRevision", "evidenceDigest", "publicationAuthority", "relatedness"].includes(key)) &&
    (p === undefined || Boolean(p && typeof p === "object" && Object.keys(p).length === 2 &&
      typeof p.authorizedByUserId === "string" && p.authorizedByUserId.length > 0 && p.authorizedByUserId.length <= 256 &&
      typeof p.objectiveDigest === "string" && /^[0-9a-f]{64}$/u.test(p.objectiveDigest))) &&
    Number.isSafeInteger(v.boundaryRevision) && (v.boundaryRevision as number) > 0 &&
    typeof v.evidenceDigest === "string" && /^[0-9a-f]{64}$/u.test(v.evidenceDigest);
}

const GRANT_REVIEW_CAUSES = ["grant_failed", "grant_uncertain", "selection", "selection_uncertain", "selection_failed", "selection_unverified"];

/** The exact shape of a selection proposal's `admit` evidence (#4103). */
export function validSelectionReview(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 4 && typeof v.occurrenceId === "string" && v.occurrenceId.length > 0 && v.occurrenceId.length <= 256 &&
    typeof v.grantDigest === "string" && /^[0-9a-f]{64}$/u.test(v.grantDigest) && v.verdict === "admit" &&
    typeof v.reason === "string" && v.reason.length <= 300;
}
const boundedText = (value: unknown, max: number) => typeof value === "string" && value.length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);

/** The exact shape of a scope proposal's grant review (#4102): server-derived, bounded, and with
 * nothing outside it. */
export function validScopeGrantReview(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const s = v.selection as Record<string, unknown> | undefined;
  return Object.keys(v).every((key) => ["cause", "ownerMessage", "messageDigest", "grantOccurrenceId", "reviewOccurrenceId", "failureClass", "reason", "selection"].includes(key)) &&
    GRANT_REVIEW_CAUSES.includes(v.cause as string) && boundedText(v.ownerMessage, 4000) &&
    typeof v.messageDigest === "string" && /^[0-9a-f]{64}$/u.test(v.messageDigest) &&
    (v.grantOccurrenceId === undefined || boundedText(v.grantOccurrenceId, 256) && (v.grantOccurrenceId as string).length > 0) &&
    (v.reviewOccurrenceId === undefined || boundedText(v.reviewOccurrenceId, 256) && (v.reviewOccurrenceId as string).length > 0) &&
    (v.failureClass === undefined || typeof v.failureClass === "string" && /^[a-z_]{1,64}$/u.test(v.failureClass)) &&
    (v.reason === undefined || boundedText(v.reason, 300)) &&
    (s === undefined || Boolean(s && typeof s === "object" && !Array.isArray(s) && Object.keys(s).length === 4 &&
      Number.isSafeInteger(s.count) && (s.count as number) >= 0 && (s.count as number) <= 100 && typeof s.defaulted === "boolean" &&
      boundedText(s.criteria, 300) && Array.isArray(s.constraints) && s.constraints.length <= 10 && s.constraints.every((c) => boundedText(c, 200))));
}

/** The exact shape of an owner review (#4267): server-derived, bounded, and with nothing outside it.
 * A Maximum Issues increase is positive and stays within the 100-issue ceiling. */
export function validScopeOwnerReview(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const m = v.maxIssuesIncrease as Record<string, unknown> | undefined;
  return Object.keys(v).every((key) => key === "cause" || key === "maxIssuesIncrease") && ["lineage_missing", "epic_not_authorized", "follow_ups_not_authorized", "publication_unapproved",
      "publication_authority_changed", "publication_approved_under_earlier_boundary", "publication_approver_not_owner", "selection_not_granted"].includes(v.cause as string) &&
    (m === undefined || Boolean(m && typeof m === "object" && !Array.isArray(m) && Object.keys(m).length === 2 &&
      Number.isSafeInteger(m.from) && (m.from as number) >= 1 && Number.isSafeInteger(m.increase) && (m.increase as number) >= 1 &&
      (m.from as number) + (m.increase as number) <= 100));
}

export function validIssueLineage(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "selection") return Object.keys(v).length === 1;
  // An epic's `repository` names one outside the launch repository (#4118).
  if (v.kind === "epic") return Object.keys(v).every((key) => ["kind", "epic", "repository"].includes(key)) && Number.isSafeInteger(v.epic) && (v.epic as number) > 0 &&
    (v.repository === undefined || typeof v.repository === "string" && campaignRepositoryLocation(v.repository) !== null);
  return Object.keys(v).length === 2 &&
    v.kind === "follow_up" && typeof v.publicationOccurrenceId === "string" && v.publicationOccurrenceId.length > 0 && v.publicationOccurrenceId.length <= 256;
}
