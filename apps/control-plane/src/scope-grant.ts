import {
  CAMPAIGN_ISSUE_SCOPE_MAX, SCOPE_GRANT_DEFAULT_SELECTION_COUNT, campaignScopeChangeResult,
  type CampaignAuthorityBoundary, type CampaignAuthorityOperation, type CampaignIssueScopeSnapshot, type FullControlDerivedLimits,
  type OrchestratorCampaignPolicy, type ScopeGrantSelection,
} from "@wollipog/protocol";
import { MAX_MESSAGE_ISSUES } from "./first-message-issue-intent.js";
import { derivedFollowUpLimit } from "./campaign-launch-admission.js";

/** Only launch-recorded derived limits follow admitted scope. Explicit limits (including No
 * Limit) and missing provenance never change. An issue-less investigation stays at one: task
 * prose and agent-authored ledger units do not prove authority for a larger budget. */
export function scopeDerivedFollowUpLimit(policy: Pick<OrchestratorCampaignPolicy, "firstMessageScope"> & Partial<Pick<OrchestratorCampaignPolicy, "behavior">> | undefined,
  boundary: CampaignAuthorityBoundary, scopeSize: number): number | undefined {
  const first = policy?.firstMessageScope;
  if (policy?.behavior?.followUps !== "execute_approved" || first?.state !== "established" ||
      first.derivedLimits?.acceptedFollowUps !== true || !boundary.budgetAuthority) return undefined;
  const selection = first.grant?.status === "granted" ? first.grant.selection?.count ?? 0 : 0;
  // Admitting more scope can size the derived allowance up. Scope removal is not an instruction
  // to lower a budget already allocated; only the owner's explicit limit editor does that.
  return Math.max(boundary.budgetAuthority.acceptedFollowUps ?? 0, derivedFollowUpLimit(Math.max(scopeSize, selection)));
}

/** Every repository in the campaign's boundary, the launch repository first (#4118). */
export function boundaryRepositories(boundary: Pick<CampaignAuthorityBoundary, "repository" | "repositories">): string[] {
  const launch = boundary.repository.toLowerCase();
  return [launch, ...(boundary.repositories ?? []).map((entry) => entry.repository.toLowerCase()).filter((repository) => repository !== launch)];
}

const simplify = (value: string) => value.trim().toLowerCase().replace(/^the\s+/u, "").replace(/\s+(?:repo|repository)$/u, "").trim();

/** The one boundary repository an owner's name for it means (#4118): its full name, its name without
 * the owner, or the name of one of its Locations, each compared exactly and ignoring case, after
 * dropping a leading "the" and a trailing "repo" or "repository". Null when the name matches no
 * repository or several, so it decides nothing. */
export function resolveRepositoryName(name: string, entries: ReadonlyArray<{ repository: string; locationNames?: readonly string[] }>): string | null {
  const wanted = simplify(name);
  if (!wanted) return null;
  const matches = entries.filter((entry) => {
    const repository = entry.repository.toLowerCase();
    return wanted === repository || wanted === repository.slice(repository.lastIndexOf("/") + 1) ||
      (entry.locationNames ?? []).some((location) => simplify(location) === wanted);
  });
  return matches.length === 1 ? matches[0]!.repository.toLowerCase() : null;
}

/** Whether the message's own words contain the name the Orchestrator says it used, as whole words,
 * ignoring case and runs of spaces: "api" is not in "rapidly". A floor: a name the owner never wrote
 * can't limit, or stand for, anything. Whether the message limits the work to it is the check's. */
export function repositoryNameInMessage(text: string, name: string): boolean {
  const flat = (value: string) => value.toLowerCase().replace(/\s+/gu, " ").trim();
  const wanted = flat(name);
  if (!wanted) return false;
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, "u").test(flat(text));
}

/** Whether the message writes the name of one of these repositories as words of its own (#4117): any
 * name `resolveRepositoryName` would accept for it, so a Location called "The API Repository" counts
 * when the message says "api". `owner/repo#12` or an issue's URL points at an issue and says nothing
 * about limiting the work, so it doesn't count. */
export function messageNamesRepository(text: string, entries: ReadonlyArray<{ repository: string; locationNames?: readonly string[] }>): boolean {
  const words = text.replace(/\S*[\w.-]+\/[\w.-]+(?:#\d+|\/(?:issues|pull)\/\d+)\S*/gu, " ");
  return entries.some((entry) => [entry.repository, entry.repository.slice(entry.repository.lastIndexOf("/") + 1), ...(entry.locationNames ?? []).map(simplify)]
    .some((name) => repositoryNameInMessage(words, name)));
}

/** A literal affirmative owner request, never a semantic guess about a repository mention.
 * Only an exact owner-named issue list followed by `in owner/repo` qualifies. Other wording,
 * exclusions, aliases, omissions and multiple repository names retain the model/owner route. */
export function exactNamedRepositoryLimit(text: string, entries: ReadonlyArray<{ repository: string; locationNames?: readonly string[] }>,
  issues: ReadonlyArray<{ repository: string; number: number; origin: string }>, references: ReadonlyArray<{ repository: string; number: number }>): string | null {
  const match = /^(?:Use the orchestrate-issues skill to )?(?:fix|implement|work on)\s+(#\d+(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)#\d+)*)\s+in\s+([\w.-]+\/[\w.-]*[\w-])(?=\s*(?:[.!\n]|$))/iu.exec(text.trim());
  if (!match) return null;
  const repository = match[2]!.toLowerCase();
  if (!entries.some((entry) => entry.repository.toLowerCase() === repository)) return null;
  const outsidePhrase = text.trim().slice(match[0].length);
  if (messageNamesRepository(outsidePhrase, entries)) return null;
  // Any later negation/qualification of the same repository is ambiguous too.
  if (repositoryNameInMessage(text.trim().slice(match[0].length), repository)) return null;
  const numbers = [...match[1]!.matchAll(/#(\d+)/gu)].map((item) => Number(item[1]));
  if (!numbers.length || new Set(numbers).size !== numbers.length || issues.length !== numbers.length ||
      issues.some((issue) => issue.origin !== "owner_named" || issue.repository.toLowerCase() !== repository || !numbers.includes(issue.number)) ||
      references.some((ref) => ref.repository.toLowerCase() !== repository || !numbers.includes(ref.number))) return null;
  return repository;
}

/** The repository a name the model returned resolves to: an empty name is the boundary's only
 * repository, and any other must match exactly one boundary entry. Anything else is null, so the
 * reference grants nothing. */
export function resolveGrantRepository(name: string, repositories: readonly string[]): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return repositories.length === 1 ? repositories[0]! : null;
  const matches = repositories.filter((repository) => repository === wanted);
  return matches.length === 1 ? matches[0]! : null;
}

/** Where `n` is written in `text` as a whole digit string: not inside a longer number. */
function digitOccurrences(text: string, n: number): number[] {
  const digits = String(n);
  const found: number[] = [];
  for (let at = text.indexOf(digits); at >= 0; at = text.indexOf(digits, at + 1)) {
    if (!/[0-9]/u.test(text[at - 1] ?? "") && !/[0-9]/u.test(text[at + digits.length] ?? "")) found.push(at);
  }
  return found;
}

/** Whether the message writes `n` as a digit string at all (the invented-number floor). */
export function writtenAsDigits(text: string, n: number): boolean {
  return digitOccurrences(text, n).length > 0;
}

/** The repository that qualifies a number written at `at`, lowercased, or null when it stands alone. */
function qualifyingRepository(text: string, at: number): string | null {
  const before = text.slice(Math.max(0, at - 300), at);
  const qualified = /([\w.-]+\/[\w.-]+)#$/u.exec(before) ??
    /https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/$/iu.exec(before) ??
    /https?:\/\/([^\s/?#@]+\/[^\s?#]+?)\/-\/(?:issues|merge_requests)\/$/iu.exec(before);
  return qualified ? qualified[1]!.toLowerCase() : null;
}

/** Whether every place the message writes `n` qualifies it with a repository outside the boundary:
 * `other/repo#n`, or an issue or pull request URL of another repository. A floor only: it can drop a
 * number the model returned unqualified, never add one. */
export function onlyOtherRepositories(text: string, n: number, repositories: readonly string[]): boolean {
  const occurrences = digitOccurrences(text, n);
  return occurrences.length > 0 && occurrences.every((at) => {
    const qualified = qualifyingRepository(text, at);
    return qualified !== null && !repositories.includes(qualified);
  });
}

/** Whether the message writes `n` for `repository` (#4118): qualified by it (`owner/api#40` or the
 * issue's URL), or, for the launch repository only, standing alone, since a bare number means the
 * launch repository. The same number qualified by another repository is that repository's issue. */
export function writtenForRepository(text: string, n: number, repository: string, launch: string): boolean {
  const wanted = repository.toLowerCase();
  return digitOccurrences(text, n).some((at) => {
    const qualified = qualifyingRepository(text, at);
    return qualified === null ? wanted === launch.toLowerCase() : qualified === wanted;
  });
}

const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

/** Whether the message states `n` as a count: its digits, or for up to twenty its English word. */
export function writtenAsCount(text: string, n: number): boolean {
  if (writtenAsDigits(text, n)) return true;
  const word = NUMBER_WORDS[n - 1];
  return word !== undefined && new RegExp(String.raw`(?<![\p{L}-])${word}(?![\p{L}-])`, "iu").test(text);
}

// What may stand between a range's two ends: a dash, `..`, `to`, `through` or `thru`, with an
// optional `#` or `issue`/`issues` before the last end.
const RANGE_JOIN = /^\s*(?:[-–—]|\.\.|to|through|thru)\s*(?:#|issues?\s+#?)?$/iu;

/** Whether the message writes `first` and `last` as one range (`#2997–#3005`, `issues 10 through
 * 14`, `10..14`), so its inner numbers come from the owner's own words, not from two numbers the
 * model joined. A floor only. */
export function writtenAsRange(text: string, first: number, last: number): boolean {
  const ends = digitOccurrences(text, last);
  return digitOccurrences(text, first).some((start) => {
    const from = start + String(first).length;
    return ends.some((end) => end > from && end - from <= 32 && RANGE_JOIN.test(text.slice(from, end)));
  });
}

/** Literal bounded range members, proving spelling only, never intent. Interiors still need
 * named_asked_for or owner approval. A bare last endpoint inherits the first one's repository. */
export function writtenRangeMembersForRepository(text: string, repository: string, launch: string): Set<number> {
  const members = new Set<number>();
  const digits = [...text.matchAll(/(?<![0-9])[0-9]+(?![0-9])/gu)];
  for (let i = 0; i + 1 < digits.length; i++) {
    const start = digits[i]!;
    const end = digits[i + 1]!;
    const from = start.index! + start[0].length;
    if (end.index! - from > 32 || !RANGE_JOIN.test(text.slice(from, end.index))) continue;
    const qualified = qualifyingRepository(text, start.index!);
    if (qualified === null && !/(?:#|\bissues?\s+)$/iu.test(text.slice(0, start.index))) continue;
    if ((qualified ?? launch.toLowerCase()) !== repository.toLowerCase()) continue;
    const first = Number(start[0]);
    const last = Number(end[0]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last - first >= CAMPAIGN_ISSUE_SCOPE_MAX) continue;
    for (let n = first; n <= last; n++) members.add(n);
  }
  return members;
}

/** The fields of a `scope_grant` verdict, as `validateDecisionOutput` returns them. */
export interface ScopeGrantFields {
  explicit: Array<{ repository: string; number: number }>;
  ranges: Array<{ repository: string; first: number; last: number }>;
  context: Array<{ repository: string; number: number }>;
  selectionRequested: boolean;
  selectionRepository: string;
  selectionCount: number;
  selectionCriteria: string;
  selectionConstraints: string[];
  narrowsOperations: boolean;
  operations: string[];
}

/** The selection input retained by the live ceiling calculation. A model-supplied count
 * absent from the owner's words (`unstatedCount`) can only lower the default. */
interface GrantSelectionInput {
  repository: string;
  requestedCount: number | null;
  unstatedCount?: number;
  criteria: string;
  constraints: string[];
}

/** The Maximum Issues the owner's approval of a failed or uncertain grant's proposal re-mints
 * (#4102). With no grant, the boundary kept the launch's ceilings, so an issue limit the launch
 * derived grows to fit the scope the owner approves plus follow-up room, as it would have for a
 * first message naming those issues; the owner's approval is the authority for it. An explicit
 * Maximum Issues never grows, a selection's proposal fits its grant's ceiling already, and nothing
 * else changes the limit. Undefined when the boundary's own limit applies. */
export function grantReviewMaxIssues(
  policy: Pick<OrchestratorCampaignPolicy, "firstMessageScope"> & Partial<Pick<OrchestratorCampaignPolicy, "behavior">> | undefined,
  snapshot: Pick<CampaignIssueScopeSnapshot, "grantReview">,
  boundary: CampaignAuthorityBoundary,
  scopeSize: number,
): number | undefined {
  const first = policy?.firstMessageScope;
  const grant = first?.state === "established" ? first.grant : undefined;
  const issues = boundary.issueAuthority;
  // Both the grant's own boundary and the current authorization must have derived the limit: one a
  // person set since, by reauthorizing with an explicit Maximum Issues, never grows.
  if (!issues || !snapshot.grantReview || snapshot.grantReview.cause === "selection" || !grant ||
      grant.status === "granted" || grant.ceilings.maxIssuesSource !== "derived" || first?.state !== "established" ||
      first.derivedLimits?.maxIssues !== true) return undefined;
  const followUps = scopeDerivedFollowUpLimit(policy, boundary, scopeSize) ?? boundary.budgetAuthority?.acceptedFollowUps;
  return Math.min(MAX_MESSAGE_ISSUES, Math.max(issues.maxIssues, followUps === undefined ? MAX_MESSAGE_ISSUES : scopeSize + followUps));
}

/** The Maximum Issues the owner's approval of an Orchestrator proposal without lineage re-mints
 * (#4267): the boundary's limit raised by exactly the increase the request stated. Undefined when it
 * states none. Null when the boundary no longer holds the limit the increase was computed against, or
 * names no issue limit at all: the request is stale and approving it must not apply. */
export function ownerReviewMaxIssues(snapshot: Pick<CampaignIssueScopeSnapshot, "ownerReview">,
  boundary: CampaignAuthorityBoundary): number | null | undefined {
  const raise = snapshot.ownerReview?.maxIssuesIncrease;
  if (!raise) return undefined;
  const issues = boundary.issueAuthority;
  if (!issues || issues.maxIssues !== raise.from || raise.from + raise.increase > MAX_MESSAGE_ISSUES) return null;
  return raise.from + raise.increase;
}

/** The operations a grant leaves: the launch's own, intersected with what the message allows. A
 * grant can never add one. */
export function grantOperations(launch: readonly CampaignAuthorityOperation[], allowed: readonly string[] | null): CampaignAuthorityOperation[] {
  return allowed === null ? [...launch] : launch.filter((operation) => allowed.includes(operation));
}

/** The selection a grant keeps under the boundary's ceilings: a stated count, or the default when
 * the message stated none, never more than an explicit Maximum Issues leaves after the named
 * issues, nor than the 100-issue scope ceiling. */
export function grantSelection(selection: GrantSelectionInput | null, scoped: number, boundary: CampaignAuthorityBoundary,
  derived: FullControlDerivedLimits | undefined): ScopeGrantSelection | undefined {
  if (!selection) return undefined;
  const wanted = selection.requestedCount ?? Math.min(SCOPE_GRANT_DEFAULT_SELECTION_COUNT, selection.unstatedCount ?? SCOPE_GRANT_DEFAULT_SELECTION_COUNT);
  const explicitMax = derived?.maxIssues ? undefined : boundary.issueAuthority?.maxIssues;
  const room = Math.max(0, Math.min(MAX_MESSAGE_ISSUES, explicitMax ?? MAX_MESSAGE_ISSUES) - scoped);
  const count = Math.min(wanted, room);
  return {
    repository: selection.repository, count, defaulted: selection.requestedCount === null,
    ...(selection.requestedCount === null ? {} : { requestedCount: selection.requestedCount }),
    ...(count < wanted ? { capped: true as const } : {}),
    criteria: selection.criteria.slice(0, 300), constraints: selection.constraints.slice(0, 10).map((c) => c.slice(0, 200)),
  };
}

/** The Maximum Issues an applied Orchestrator scope proposal sets (#4282) when the launch derived the
 * limit: the scope it establishes plus follow-up room, as a first message naming those issues derived
 * it before, never below the current limit and never past the 100-issue ceiling. The owner's words
 * stand behind every such scope: the floors bound owner-named issues to them, and anything else was
 * the owner's own approval. An explicit Maximum Issues never grows. Undefined when it doesn't apply. */
export function proposalMaxIssues(policy: Pick<OrchestratorCampaignPolicy, "firstMessageScope"> & Partial<Pick<OrchestratorCampaignPolicy, "behavior">> | undefined,
  snapshot: Pick<CampaignIssueScopeSnapshot, "scopeProposal">, boundary: CampaignAuthorityBoundary, scopeSize: number): number | undefined {
  const first = policy?.firstMessageScope;
  const issues = boundary.issueAuthority;
  if (!snapshot.scopeProposal || !issues || first?.state !== "established" || first.grant?.status !== "proposal" ||
      first.derivedLimits?.maxIssues !== true) return undefined;
  const followUps = scopeDerivedFollowUpLimit(policy, boundary, scopeSize) ?? boundary.budgetAuthority?.acceptedFollowUps;
  return Math.min(MAX_MESSAGE_ISSUES, Math.max(issues.maxIssues, followUps === undefined ? MAX_MESSAGE_ISSUES : scopeSize + followUps));
}

/** The Maximum Issues increase the owner's approval of this scope request applies, to name it where the
 * request is listed (#4334): the one an owner review states, or the derived limit a failed or uncertain
 * grant or a proposal grows to fit, which no snapshot field records. `boundary` is the one the approval
 * would re-mint, absent when it wouldn't, and the scope size is the change's own result. It reads the
 * limit and decides nothing; approval still applies its own rules. */
export function scopeApprovalMaxIssuesIncrease(policy: Pick<OrchestratorCampaignPolicy, "firstMessageScope"> | undefined,
  snapshot: CampaignIssueScopeSnapshot, boundary: CampaignAuthorityBoundary | undefined): { from: number; increase: number } | undefined {
  if (snapshot.ownerReview?.maxIssuesIncrease) return snapshot.ownerReview.maxIssuesIncrease;
  const from = boundary?.issueAuthority?.maxIssues;
  if (!boundary || from === undefined) return undefined;
  const scopeSize = campaignScopeChangeResult(snapshot).length;
  const grown = proposalMaxIssues(policy, snapshot, boundary, scopeSize) ?? grantReviewMaxIssues(policy, snapshot, boundary, scopeSize);
  return grown !== undefined && grown > from ? { from, increase: grown - from } : undefined;
}
