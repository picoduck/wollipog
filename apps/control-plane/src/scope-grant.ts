import {
  SCOPE_GRANT_DEFAULT_SELECTION_COUNT,
  type CampaignAuthorityBoundary, type CampaignAuthorityOperation, type CampaignIssueScopeSnapshot, type FullControlDerivedLimits,
  type OrchestratorCampaignPolicy, type ScopeGrantDropReason, type ScopeGrantSelection,
} from "@wollipog/protocol";
import { MAX_MESSAGE_ISSUES } from "./first-message-issue-intent.js";

/** Every repository in the campaign's boundary, the launch repository first (#4118). */
export function boundaryRepositories(boundary: Pick<CampaignAuthorityBoundary, "repository" | "repositories">): string[] {
  const launch = boundary.repository.toLowerCase();
  return [launch, ...(boundary.repositories ?? []).map((entry) => entry.repository.toLowerCase()).filter((repository) => repository !== launch)];
}

/** The one boundary repository an owner's name for it means (#4118): its full name, its name without
 * the owner, or the name of one of its Locations, each compared exactly and ignoring case, after
 * dropping a leading "the" and a trailing "repo" or "repository". Null when the name matches no
 * repository or several, so it decides nothing. */
export function resolveRepositoryName(name: string, entries: ReadonlyArray<{ repository: string; locationNames?: readonly string[] }>): string | null {
  const simplify = (value: string) => value.trim().toLowerCase().replace(/^the\s+/u, "").replace(/\s+(?:repo|repository)$/u, "").trim();
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

/** What a verdict may grant after the floors that need no runner, before the runner verifies the
 * numbers. Every number is in the campaign repository (`repository`). */
export interface ScopeGrantCandidates {
  repository: string;
  explicit: number[];
  context: number[];
  dropped: Array<{ repository: string; number: number; reason: ScopeGrantDropReason }>;
  /** `requestedCount` is a count the message states; `unstatedCount` one the model gave that the
   * message does not, which can only lower the default. */
  selection: { repository: string; requestedCount: number | null; unstatedCount?: number; criteria: string; constraints: string[] } | null;
  /** The operations the message leaves, when it narrowed them; null when it did not. */
  operations: string[] | null;
}

/**
 * The deterministic floors on a healthy verdict (#4102). They only remove:
 *
 * - every explicit number, and both ends of every range, must be written in the message as a digit
 *   string; a number the model invented is dropped;
 * - every reference must resolve to a repository in the campaign's boundary, and a number the message
 *   writes only qualified by another repository is dropped even when the model left it unqualified;
 * - a range expands only when ascending and narrower than 100 issues, and only while every range
 *   expanded keeps the message within 100 distinct issues;
 * - a number the model lists both as named and as context is context.
 *
 * The runner then verifies what is left as issues of the campaign repository (`verifyGrant`).
 */
export function scopeGrantCandidates(text: string, fields: ScopeGrantFields, boundary: Pick<CampaignAuthorityBoundary, "repository">): ScopeGrantCandidates {
  const repositories = boundaryRepositories(boundary);
  const repository = repositories[0]!;
  const dropped: ScopeGrantCandidates["dropped"] = [];
  const drop = (name: string, number: number, reason: ScopeGrantDropReason) => {
    const at = resolveGrantRepository(name, repositories) ?? (name.trim().toLowerCase() || repository);
    if (!dropped.some((d) => d.repository === at && d.number === number)) dropped.push({ repository: at, number, reason });
  };
  // The floors every single number passes: written in the message, in the boundary.
  const admissible = (name: string, number: number): boolean => {
    if (!writtenAsDigits(text, number)) { drop(name, number, "not_in_message"); return false; }
    const resolved = resolveGrantRepository(name, repositories);
    if (resolved !== repository || onlyOtherRepositories(text, number, repositories)) { drop(name, number, "other_repository"); return false; }
    return true;
  };
  const context = new Set<number>();
  for (const ref of fields.context) {
    if (writtenAsDigits(text, ref.number) && resolveGrantRepository(ref.repository, repositories) === repository &&
        !onlyOtherRepositories(text, ref.number, repositories)) context.add(ref.number);
  }
  const explicit = new Set<number>();
  for (const ref of fields.explicit) if (admissible(ref.repository, ref.number)) explicit.add(ref.number);
  const ranges = fields.ranges.filter((range) => {
    const ends = [range.first, range.last].map((n) => admissible(range.repository, n));
    if (!ends.every(Boolean)) return false;
    // Two numbers the message writes apart are not a range the owner asked for, and a range whose
    // end is context is not one either: neither expands.
    if (!writtenAsRange(text, range.first, range.last) || context.has(range.first) || context.has(range.last)) {
      drop(range.repository, range.first, "range_not_in_message"); drop(range.repository, range.last, "range_not_in_message");
      return false;
    }
    if (range.first >= range.last || range.last - range.first >= MAX_MESSAGE_ISSUES) {
      drop(range.repository, range.first, "range_too_wide"); drop(range.repository, range.last, "range_too_wide");
      return false;
    }
    return true;
  });
  const expanded = new Set(explicit);
  for (const range of ranges) for (let n = range.first; n <= range.last && expanded.size <= MAX_MESSAGE_ISSUES; n++) expanded.add(n);
  if (expanded.size <= MAX_MESSAGE_ISSUES) for (const n of expanded) explicit.add(n);
  else for (const range of ranges) { drop(range.repository, range.first, "range_too_wide"); drop(range.repository, range.last, "range_too_wide"); }
  for (const n of context) explicit.delete(n);
  const sorted = (values: Iterable<number>) => [...values].sort((a, b) => a - b);
  const selectionRepository = fields.selectionRequested ? resolveGrantRepository(fields.selectionRepository, repositories) : null;
  return {
    repository,
    explicit: sorted(explicit).slice(0, MAX_MESSAGE_ISSUES),
    context: sorted(context).slice(0, MAX_MESSAGE_ISSUES),
    dropped: dropped.sort((a, b) => a.number - b.number),
    selection: selectionRepository ? {
      repository: selectionRepository,
      // A count the message does not state is not the owner's: it never raises the default.
      requestedCount: fields.selectionCount > 0 && writtenAsCount(text, fields.selectionCount) ? fields.selectionCount : null,
      ...(fields.selectionCount > 0 && !writtenAsCount(text, fields.selectionCount) ? { unstatedCount: fields.selectionCount } : {}),
      criteria: fields.selectionCriteria.replace(/\s+/gu, " ").trim(),
      constraints: fields.selectionConstraints.map((c) => c.replace(/\s+/gu, " ").trim()).filter(Boolean),
    } : null,
    operations: fields.narrowsOperations ? fields.operations : null,
  };
}

/** The Maximum Issues the owner's approval of a failed or uncertain grant's proposal re-mints
 * (#4102). With no grant, the boundary kept the launch's ceilings, so an issue limit the launch
 * derived grows to fit the scope the owner approves plus follow-up room, as it would have for a
 * first message naming those issues; the owner's approval is the authority for it. An explicit
 * Maximum Issues never grows, a selection's proposal fits its grant's ceiling already, and nothing
 * else changes the limit. Undefined when the boundary's own limit applies. */
export function grantReviewMaxIssues(
  policy: Pick<OrchestratorCampaignPolicy, "firstMessageScope"> | undefined,
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
  const followUps = boundary.budgetAuthority?.acceptedFollowUps;
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
export function grantSelection(selection: ScopeGrantCandidates["selection"], scoped: number, boundary: CampaignAuthorityBoundary,
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
export function proposalMaxIssues(policy: Pick<OrchestratorCampaignPolicy, "firstMessageScope"> | undefined,
  snapshot: Pick<CampaignIssueScopeSnapshot, "scopeProposal">, boundary: CampaignAuthorityBoundary, scopeSize: number): number | undefined {
  const first = policy?.firstMessageScope;
  const issues = boundary.issueAuthority;
  if (!snapshot.scopeProposal || !issues || first?.state !== "established" || first.grant?.status !== "proposal" ||
      first.derivedLimits?.maxIssues !== true) return undefined;
  const followUps = boundary.budgetAuthority?.acceptedFollowUps;
  return Math.min(MAX_MESSAGE_ISSUES, Math.max(issues.maxIssues, followUps === undefined ? MAX_MESSAGE_ISSUES : scopeSize + followUps));
}
