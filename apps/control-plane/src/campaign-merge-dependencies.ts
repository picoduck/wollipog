/**
 * Cross-repository merge dependencies (#4120; docs/campaign-work-ledger.md "Merge Dependencies").
 * Pure: no clock, no database. The ledger store derives display state from these rules, and the
 * merge gate holds a dependent's merge with them, so both read one definition.
 *
 * A dependency is a merge dependency when the prerequisite works in another repository than its
 * dependent. Forges have no atomic cross-repository merge, so such a dependency is met only once
 * every pull request the prerequisite names is observed MERGED on its forge. `delivered` is the
 * Orchestrator's verification, and an enqueued pull request can still be ejected, so neither meets
 * it. A dependency within one repository keeps its earlier, display-only meaning.
 */
import type {
  CampaignIssueRef,
  CampaignMergeHoldState,
  CampaignMergeDependencyStatus,
  CampaignMergeDependencyView,
  CampaignPullRequestRef,
  CampaignWorkItemCommitmentState,
} from "@wollipog/protocol";
import type { ForgeFact } from "./campaign-forge-observations.js";

/** The repository an item works in, lower-cased: where its latest attempt's child is placed (a
 * server fact, #4119), else the repository of the first pull request it names, else its issue's.
 * Null when none is known. */
export function campaignItemRepository(input: {
  placement: string | null;
  pullRequests: readonly CampaignPullRequestRef[];
  issue: CampaignIssueRef | null;
}): string | null {
  const repository = input.placement ?? input.pullRequests[0]?.repository ?? input.issue?.repository ?? null;
  return repository ? repository.toLowerCase() : null;
}

/** Every repository an item works in, lower-cased and without repeats: its child's placement and each
 * pull request it names. A pull request's own repository counts even when the child is placed
 * elsewhere. Its issue's repository counts only when neither is known, since a feature issue in one
 * repository is often delivered by work in another. Empty when none is known. */
export function campaignItemRepositories(input: {
  placement: string | null;
  pullRequests: readonly CampaignPullRequestRef[];
  issue: CampaignIssueRef | null;
}): string[] {
  const worked = [input.placement, ...input.pullRequests.map((ref) => ref.repository)];
  return [...new Set((worked.some(Boolean) ? worked : [input.issue?.repository ?? null])
    .flatMap((repository) => repository ? [repository.toLowerCase()] : []))];
}

/**
 * Whether a dependency is a merge dependency (#4120). Only a campaign of several repositories has
 * them; one of a single repository, or one that records none (from before #4117), keeps every
 * dependency display-only, as before. In a campaign of several it fails closed:
 * - an item whose repository is unknown might work in any of them, so a dependency on or from one is
 *   a merge dependency;
 * - otherwise it is one when any repository the prerequisite works in differs from any the dependent
 *   works in.
 */
export function isCampaignMergeDependency(dependentRepositories: readonly string[], prerequisiteRepositories: readonly string[],
  campaignRepositories: readonly string[]): boolean {
  // A campaign of one repository behaves as before #4120, whatever repository an item names.
  if (campaignRepositories.length < 2) return false;
  const resolve = (repositories: readonly string[]) => repositories.length ? repositories.map((repository) => repository.toLowerCase()) : null;
  const dependent = resolve(dependentRepositories), prerequisite = resolve(prerequisiteRepositories);
  if (!dependent || !prerequisite) return true;
  return prerequisite.some((repository) => dependent.some((other) => other !== repository));
}

/** What the rules read about one prerequisite. */
export interface CampaignMergePrerequisite {
  id: string;
  key: string;
  title: string | null;
  /** Its repository for display (`campaignItemRepository`); null when none is known. */
  repository: string | null;
  commitment: CampaignWorkItemCommitmentState;
  /** Every pull request it names, with its stored forge fact, in order. `outside`: the pull request
   * is in no repository of the campaign, so its fact (read through the root's login at best) never
   * meets a hold; the store gives it an unavailable fact. */
  pullRequests: ReadonlyArray<{ ref: CampaignPullRequestRef; fact: ForgeFact; outside?: true }>;
}

const shown = (fact: ForgeFact): "open" | "closed" | "merged" | "unknown" =>
  fact.availability === "unavailable" ? "unknown" : fact.value.state;

/** The status a dependent shows. A merge already read stays a merge as its observation ages, since a
 * forge never un-merges a pull request; the gate itself still reads it fresh (`campaignMergeHold`). */
export function campaignMergeDependencyStatus(prerequisite: CampaignMergePrerequisite): CampaignMergeDependencyStatus {
  if (prerequisite.commitment !== "committed") return "failed";
  if (!prerequisite.pullRequests.length) return "unmerged";
  const states = prerequisite.pullRequests.map(({ fact }) => shown(fact));
  if (states.includes("closed")) return "failed";
  return states.every((state) => state === "merged") ? "merged" : "unmerged";
}

export function campaignMergeDependencyView(prerequisite: CampaignMergePrerequisite): CampaignMergeDependencyView {
  return {
    id: prerequisite.id,
    key: prerequisite.key,
    title: prerequisite.title,
    repository: prerequisite.repository?.toLowerCase() ?? null,
    status: campaignMergeDependencyStatus(prerequisite),
    pullRequests: prerequisite.pullRequests.map(({ ref, fact }) => ({ ref: { repository: ref.repository, number: ref.number }, state: shown(fact) })),
  };
}

/** Why a merge is held on this prerequisite, or null when it is met. Only a FRESH observation of
 * MERGED meets it: a stale or unavailable fact, an open or enqueued pull request, or a prerequisite
 * that names none holds the merge. A closed one or a cancelled prerequisite holds it for good.
 * `staleMergedMeets` is for checks of a merge already armed, and only those: the arming read
 * proved every prerequisite it had MERGED afresh, the ledger refuses new ones while it is armed, and
 * a forge never un-merges, so a stored MERGED that has aged still meets it. Before arming, a
 * prerequisite added after the authoritative read has only what is stored, which proves nothing. */
export interface CampaignMergeHold {
  prerequisite: { id: string; key: string; title: string | null; repository: string | null };
  pullRequest: CampaignPullRequestRef | null;
  state: CampaignMergeHoldState;
  /** The head of the pull request it waits on, when one was observed. */
  headSha: string | null;
}

export function campaignMergeHold(prerequisite: CampaignMergePrerequisite, options: { staleMergedMeets?: boolean } = {}): CampaignMergeHold | null {
  const identity = { id: prerequisite.id, key: prerequisite.key, title: prerequisite.title, repository: prerequisite.repository?.toLowerCase() ?? null };
  if (prerequisite.commitment !== "committed") return { prerequisite: identity, pullRequest: null, state: "cancelled", headSha: null };
  if (!prerequisite.pullRequests.length) return { prerequisite: identity, pullRequest: null, state: "none", headSha: null };
  // No Location of that repository can read it, so nothing proves it merged; it waits for the
  // repository to join the campaign.
  const outside = prerequisite.pullRequests.find((entry) => entry.outside);
  if (outside) return { prerequisite: identity, pullRequest: outside.ref, state: "outside", headSha: null };
  const closed = prerequisite.pullRequests.find(({ fact }) => fact.availability === "fresh" && fact.value.state === "closed");
  if (closed) return { prerequisite: identity, pullRequest: closed.ref, state: "closed", headSha: closed.fact.availability === "fresh" ? closed.fact.value.headSha : null };
  const met = (fact: ForgeFact) => fact.availability === "fresh" ? fact.value.state === "merged"
    : fact.availability === "stale" && options.staleMergedMeets === true && fact.value.state === "merged";
  const waiting = prerequisite.pullRequests.find(({ fact }) => !met(fact));
  if (!waiting) return null;
  const { fact } = waiting;
  const head = fact.availability === "unavailable" ? fact.lastValue?.headSha ?? null : fact.value.headSha;
  return { prerequisite: identity, pullRequest: waiting.ref, state: fact.availability === "fresh" ? "open" : "unobserved", headSha: head };
}

/** The first unmet prerequisite, closed or cancelled ones before those still open: a merge that can
 * never be attempted says so rather than waiting. */
export function campaignFirstMergeHold(prerequisites: readonly CampaignMergePrerequisite[],
  options: { staleMergedMeets?: boolean } = {}): CampaignMergeHold | null {
  const holds = prerequisites.map((prerequisite) => campaignMergeHold(prerequisite, options)).filter((hold): hold is CampaignMergeHold => hold !== null);
  return holds.find((hold) => hold.state === "closed" || hold.state === "cancelled") ?? holds[0] ?? null;
}
