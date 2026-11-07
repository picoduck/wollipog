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

/** Whether a dependency is a merge dependency: both repositories are known and differ. An item whose
 * repository is unknown keeps today's behavior. */
export function isCampaignMergeDependency(dependentRepository: string | null, prerequisiteRepository: string | null): boolean {
  return Boolean(dependentRepository && prerequisiteRepository &&
    dependentRepository.toLowerCase() !== prerequisiteRepository.toLowerCase());
}

/** What the rules read about one prerequisite. */
export interface CampaignMergePrerequisite {
  id: string;
  key: string;
  title: string | null;
  repository: string;
  commitment: CampaignWorkItemCommitmentState;
  /** Every pull request it names, with its stored forge fact, in order. */
  pullRequests: ReadonlyArray<{ ref: CampaignPullRequestRef; fact: ForgeFact }>;
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
    repository: prerequisite.repository.toLowerCase(),
    status: campaignMergeDependencyStatus(prerequisite),
    pullRequests: prerequisite.pullRequests.map(({ ref, fact }) => ({ ref: { repository: ref.repository, number: ref.number }, state: shown(fact) })),
  };
}

/** Why a merge is held on this prerequisite, or null when it is met. Only a FRESH observation of
 * MERGED meets it: a stale or unavailable fact, an open or enqueued pull request, or a prerequisite
 * that names none holds the merge. A closed one or a cancelled prerequisite holds it for good. */
export interface CampaignMergeHold {
  prerequisite: { id: string; key: string; title: string | null; repository: string };
  pullRequest: CampaignPullRequestRef | null;
  state: "open" | "closed" | "unobserved" | "none" | "cancelled";
  /** The head of the pull request it waits on, when one was observed. */
  headSha: string | null;
}

export function campaignMergeHold(prerequisite: CampaignMergePrerequisite): CampaignMergeHold | null {
  const identity = { id: prerequisite.id, key: prerequisite.key, title: prerequisite.title, repository: prerequisite.repository.toLowerCase() };
  if (prerequisite.commitment !== "committed") return { prerequisite: identity, pullRequest: null, state: "cancelled", headSha: null };
  if (!prerequisite.pullRequests.length) return { prerequisite: identity, pullRequest: null, state: "none", headSha: null };
  const closed = prerequisite.pullRequests.find(({ fact }) => fact.availability === "fresh" && fact.value.state === "closed");
  if (closed) return { prerequisite: identity, pullRequest: closed.ref, state: "closed", headSha: closed.fact.availability === "fresh" ? closed.fact.value.headSha : null };
  const waiting = prerequisite.pullRequests.find(({ fact }) => fact.availability !== "fresh" || fact.value.state !== "merged");
  if (!waiting) return null;
  const { fact } = waiting;
  const head = fact.availability === "unavailable" ? fact.lastValue?.headSha ?? null : fact.value.headSha;
  return { prerequisite: identity, pullRequest: waiting.ref, state: fact.availability === "fresh" ? "open" : "unobserved", headSha: head };
}

/** The first unmet prerequisite, closed or cancelled ones before those still open: a merge that can
 * never be attempted says so rather than waiting. */
export function campaignFirstMergeHold(prerequisites: readonly CampaignMergePrerequisite[]): CampaignMergeHold | null {
  const holds = prerequisites.map(campaignMergeHold).filter((hold): hold is CampaignMergeHold => hold !== null);
  return holds.find((hold) => hold.state === "closed" || hold.state === "cancelled") ?? holds[0] ?? null;
}
