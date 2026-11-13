import { createHash } from "node:crypto";
import { campaignBoundaryRepository, runnerSupportsProtocol, campaignPublicationSafe, campaignPublicationTitle, campaignScopeIssues, type CampaignPublicationAdmissionFailure, type SessionView, type GithubIssueClosureSnapshot,
  type WorkflowDecisionResourceSnapshot, type CampaignWorkItemDetail, type CampaignPullRequestRef, type CampaignRecommendation,
  ISSUE_CLOSURE_DELIVERY_GAPS_MAX, issueClosureDeliveryGap, type IssueClosureDeliveryGap, type IssueClosureDeliveryGapCode,
  type IssueClosureEpicMembers, type CampaignForgeChangeRequestObservation } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { campaignBoundaryCurrent, campaignClosureIssueHeld, campaignIssueInScope, campaignScopeRepositories } from "./campaign-authority.js";
import { forgeRefKey, type ForgeFactEntry } from "./campaign-forge-observations.js";

export const issueEvidenceDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Complete ledger identities, never issue prose. A failed or incomplete read preserves the
 * conservative runner rule. Include other issues' PRs: any open PR of this campaign is a gap. */
export function closureCampaignPullRequests(db: ControlPlaneDb, root: SessionView, repository: string): number[] | undefined {
  try {
    const history = db.campaignWorkLedger.closurePullRequestHistory(root.id, repository);
    if (history === undefined) return undefined;
    const refs = new Set<number>(history);
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = db.campaignWorkLedger.page(root.id, { state: "all", limit: 100, ...(cursor ? { cursor } : {}) }, Date.now());
      if (!page.ok) return undefined;
      for (const item of page.data.items) {
        if (seen.has(item.id) || seen.size >= 10_000) return undefined;
        seen.add(item.id);
        const detail = db.campaignWorkLedger.detail(root.id, item.id, Date.now());
        if (!detail || !detail.deliveries) return undefined;
        for (const pr of [...(detail.stage?.pullRequests ?? []), ...detail.deliveries.flatMap((delivery) => delivery.pullRequests)]) {
          if (pr.repository.toLowerCase() === repository.toLowerCase()) refs.add(pr.number);
        }
      }
      cursor = page.data.nextCursor ?? undefined;
    } while (cursor);
    return [...refs].sort((a, b) => a - b);
  } catch { return undefined; }
}

/** Allowlisted messages only: runner reason fields and error text are untrusted input. */
export function campaignScopeTargetFailureMessage(reason: unknown): string {
  switch (reason) {
    case "runner_mismatch":
      return "The campaign's saved execution target does not match its runner. Verify the assigned runner and saved placement before retrying.";
    case "unsupported_adapter":
      return "Campaign scope supports only local or SSH host execution targets. Use a supported host placement before retrying.";
    case "workspace_mismatch":
      return "The campaign's saved workspace strategy does not match its execution target. Verify the saved placement before retrying.";
    case "filesystem_mismatch":
      return "The campaign's saved filesystem boundary does not match its host placement. Verify the saved placement before retrying.";
    case "stale_network_policy":
      return "The campaign's saved network boundary no longer matches the runner's current isolation policy. Review the runner policy and saved placement before retrying.";
    case "unsupported_host_boundaries":
      return "The campaign's saved secrets or billing boundary is unsupported for a host placement. Review the saved placement before retrying.";
    default:
      return "Campaign scope requires a valid local or SSH host execution target belonging to its runner. Container and cloud targets are not supported.";
  }
}

/** How many issues the campaign holds across every repository (#4118): the size Maximum Issues
 * limits. `issueNumbers` is only the launch repository's part. */
export function heldCampaignIssues(root: Pick<SessionView, "orchestratorPolicy">): number {
  const policy = root.orchestratorPolicy;
  return policy?.issueScope ? campaignScopeIssues(policy.issueScope).length : policy?.issueNumbers?.length ?? 0;
}

export function issueBoundary(root: SessionView) {
  const control = root.orchestratorPolicy?.control;
  return control?.mode === "full_control" && campaignBoundaryCurrent(root) && control.boundary.issueAuthority ? control.boundary : null;
}

export function issueWork(db: ControlPlaneDb, root: SessionView, issue: number,
  repository: string | undefined = root.orchestratorPolicy?.issueScope?.repository): CampaignWorkItemDetail[] {
  const fixedBy = repository && db.campaignWorkLedger.fixedBy(root.id, repository, issue);
  const items: CampaignWorkItemDetail[] = [];
  if (fixedBy) {
    const cited = fixedBy.map((id) => db.campaignWorkLedger.detail(root.id, id, Date.now()));
    // Do not silently drop a missing or out-of-scope unit and prove only a subset.
    if (cited.some((item) => !item || !item.issue || item.issue.repository.toLowerCase() !== repository!.toLowerCase() ||
        !campaignClosureIssueHeld(root.orchestratorPolicy, item.issue))) return [];
    items.push(...cited as CampaignWorkItemDetail[]);
  }
  const tracked = trackedIssueWork(db, root, issue, repository);
  if (!tracked) return [];
  for (const detail of tracked) if (!items.some((existing) => existing.id === detail.id)) items.push(detail);
  return items;
}

/** The ledger's own work items for this issue, without its fixed-by plan; null when the ledger cannot be read. */
function trackedIssueWork(db: ControlPlaneDb, root: SessionView, issue: number, repository: string | undefined): CampaignWorkItemDetail[] | null {
  const items: CampaignWorkItemDetail[] = [];
  let cursor: string | undefined;
  do {
    const page = db.campaignWorkLedger.page(root.id, { state: "all", limit: 100, ...(cursor ? { cursor } : {}) }, Date.now());
    if (!page.ok) return null;
    for (const item of page.data.items) if (item.issue?.number === issue &&
        item.issue.repository.toLowerCase() === repository?.toLowerCase()) {
      const detail = db.campaignWorkLedger.detail(root.id, item.id, Date.now());
      if (detail && !items.some((existing) => existing.id === detail.id)) items.push(detail);
    }
    cursor = page.data.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

/** Shared publication/scope floor. Missing and foreign items never count as owned work. */
export function followUpOriginEvidence(db: ControlPlaneDb, root: SessionView, ids: readonly string[],
  requesterRunnerId = root.runnerId) {
  const failed = (reason: string) => ({ failure: "origin_outside_scope" as const, reason });
  if (!ids.length) return failed("The follow-up has no recorded origin work items.");
  const origins: NonNullable<CampaignWorkItemDetail["issue"]>[] = [];
  const issueLessOrigins: string[] = [];
  for (const id of ids) {
    const item = db.campaignWorkLedger.detail(root.id, id, Date.now());
    if (!item) return failed("The follow-up's origin work item is missing or belongs to another campaign.");
    if (item.issue) {
      if (!campaignIssueInScope(root.orchestratorPolicy, item.issue))
        return failed("The published follow-up's origin issue was removed from this campaign's scope.");
      origins.push(item.issue);
    } else {
      if (!db.campaignWorkLedger.issueLessCampaignOrigin(root.id, id))
        return failed("The follow-up's issue-less origin is not proven to be investigation work created by this campaign's root or scheduled automation.");
      if (![root.runnerId, requesterRunnerId].every((runnerId) =>
        runnerSupportsProtocol(db.getRunner(runnerId)?.protocolVersion, "issueLessCampaignOrigins")))
        return failed("The follow-up's issue-less campaign origin requires newer runners; older runners retain issue-scope review.");
      issueLessOrigins.push(id);
    }
  }
  return { origins, ...(issueLessOrigins.length ? { originBasis: { basis: "issue-less campaign origin" as const, workItemIds: issueLessOrigins } } : {}) };
}

export function publicationEvidence(db: ControlPlaneDb, root: SessionView,
  snapshot: Extract<WorkflowDecisionResourceSnapshot, { category: "follow_up_issue_publication" }>) {
  const checked = publicationEvidenceCheck(db, root, snapshot);
  return "evidence" in checked ? checked.evidence : null;
}

/** The same proof, naming the first condition that failed so a human fallback is never silent. */
export function publicationEvidenceCheck(db: ControlPlaneDb, root: SessionView,
  snapshot: Extract<WorkflowDecisionResourceSnapshot, { category: "follow_up_issue_publication" }>) {
  const failed = (failure: CampaignPublicationAdmissionFailure) => ({ failure });
  const boundary = issueBoundary(root);
  if (!boundary?.issueAuthority?.relatedFollowUps || !boundary.operations.includes(snapshot.category)) return failed("no_issue_boundary");
  // #4119: any repository of the boundary; another Project repository must be added first.
  if (!campaignBoundaryRepository(boundary, snapshot.repository)) return failed("target_outside_boundary");
  if (!snapshot.recommendationId) return failed("recommendation_not_found");
  if (!campaignPublicationSafe(snapshot.sanitizedTitle, snapshot.sanitizedBody, snapshot.labels)) return failed("unsafe_payload");
  const recommendation = db.campaignWorkLedger.recommendation(root.id, snapshot.recommendationId);
  if (!recommendation || recommendation.repository.toLowerCase() !== snapshot.repository) return failed("recommendation_not_found");
  if (recommendation.disposition !== "accepted" || recommendation.duplicateOfId || !recommendation.dispositionReason) return failed("recommendation_not_accepted");
  if (recommendation.publication !== "awaiting_publication") return failed("recommendation_spent");
  if (campaignPublicationTitle(recommendation.title) !== campaignPublicationTitle(snapshot.sanitizedTitle)) return failed("title_mismatch");
  const originEvidence = followUpOriginEvidence(db, root, recommendation.originWorkItemIds);
  if ("failure" in originEvidence) return originEvidence;
  const { origins, originBasis } = originEvidence;
  // A follow-up in another repository than its origins records both in its lineage.
  const originRefs = [...new Set(origins.map((issue) => `${issue!.repository.toLowerCase()}#${issue!.number}`))].sort();
  const lineage = originRefs.some((ref) => !ref.startsWith(`${snapshot.repository}#`))
    ? { target: snapshot.repository, origins: originRefs } : undefined;
  // Scope capacity includes every outstanding publication reservation, so concurrent approvals
  // cannot consume the same final slot. This hook composes with aggregate campaign limits.
  const grants = db.campaignPublicationReservations(root.id);
  if (grants.some((d) => d.status === "consumed" && d.resourceSnapshot.category === snapshot.category && d.resourceSnapshot.recommendationId === snapshot.recommendationId)) return failed("recommendation_spent");
  const reservations = reservedPublicationSlots(db, root, undefined, snapshot.recommendationId);
  if (heldCampaignIssues(root) + reservations >= db.campaignIssueLimit(root.id, boundary.issueAuthority.maxIssues)) {
    return failed("capacity_exhausted");
  }
  return { evidence: { recommendation, origins, ...(originBasis ? { originBasis } : {}), scopeRevision: boundary.issueScopeRevision, boundaryRevision: boundary.revision,
    ...(lineage ? { lineage } : {}) } };
}

/** Why the server refused an Orchestrator's own Full Control scope change (#2940). Each code names
 * the one condition that failed and maps to a fixed sentence; neither carries issue or payload text.
 * Additions without any lineage are not refused: they become the owner's typed approval (#4267). */
export type CampaignScopeAdmissionFailure =
  | "capacity_exhausted" | "epic_not_authorized" | "epic_members_unverified"
  | "payload_title_mismatch" | "payload_body_mismatch" | "payload_labels_mismatch" | "payload_read_failed"
  | "follow_ups_not_authorized" | "follow_up_not_single" | "publication_not_found" | "publication_not_consumed"
  | "publication_already_admitted" | "publication_unapproved" | "publication_approved_under_earlier_boundary" | "publication_approver_not_owner"
  | "publication_authority_changed" | "recommendation_not_found" | "recommendation_not_accepted" | "resulting_issue_mismatch" | "origin_outside_scope" | "payload_mismatch"
  // Selection lineage (#4103): its deterministic floors, in the order they run.
  | "selection_not_granted" | "selection_additions_only" | "selection_launch_repository_only" | "repository_outside_boundary" | "not_an_issue" | "issue_not_open"
  | "already_in_scope" | "other_campaign_scope" | "selection_count_exhausted" | "human_required_label"
  // The Orchestrator's own scope proposal (#4282): its floors beyond those above.
  | "owner_named_not_in_message" | "proposal_additions_only" | "proposal_count_exceeded" | "requested_count_not_in_message" | "requested_all_not_in_message"
  | "repository_name_not_in_message" | "repository_constraint_mismatch"
  // The Decision Model's constraint check of that proposal (#4282) refused it.
  | "constraint_check_refused";

const HUMAN_SCOPE_ROUTE = "ask the campaign owner to propose this change from Campaign Status";

// The seven owner-review causes retain their legacy refusal catalog for compatibility. The current
// proposal route uses them as server-derived review causes, never as refusals (#4333).
export const CAMPAIGN_SCOPE_ADMISSION_REFUSALS: Readonly<Record<CampaignScopeAdmissionFailure, { status: number; message: string }>> = {
  // Names the limit and the owner's route to raise it (#4061); no agent can raise it.
  capacity_exhausted: { status: 409, message: "Scope and publication reservations exceed this campaign's Maximum Issues, the issue limit " +
    "its Full Control authorization set. Only the person who authorized Full Control can raise it: in Campaign Status, raise the " +
    "Follow-Up Limit, which raises Maximum Issues by as much, or choose No Limit. Ask that person; an Orchestrator can't raise it." },
  epic_not_authorized: { status: 403, message: `The named epic is not one this campaign's Full Control boundary authorizes; ${HUMAN_SCOPE_ROUTE}.` },
  epic_members_unverified: { status: 409, message: "Additions are not verified members of a human-authorized epic" },
  follow_ups_not_authorized: { status: 403, message: `This campaign's Full Control boundary does not authorize related follow-ups; ${HUMAN_SCOPE_ROUTE}.` },
  follow_up_not_single: { status: 403, message: "Follow-up lineage admits exactly one issue; propose each published follow-up as its own addition." },
  publication_not_found: { status: 409, message: "The named publication is not a follow-up issue publication this campaign controls in its repository." },
  publication_not_consumed: { status: 409, message: "The named publication has not been consumed; publish its approved payload before admitting the issue." },
  publication_already_admitted: { status: 409, message: "The named publication was already used to admit an issue; each publication admits one issue once." },
  publication_unapproved: { status: 409, message: "The named publication has neither a bounded admission nor a recorded approval by a person; use fresh human scope review." },
  publication_approved_under_earlier_boundary: { status: 403, message: "The named publication was approved before the current Full Control authorization, " +
    `so its objective is unproven; ${HUMAN_SCOPE_ROUTE}.` },
  publication_approver_not_owner: { status: 403, message: "The named publication was approved by a person who is neither the Full Control boundary's author " +
    `nor an owner of this campaign; ${HUMAN_SCOPE_ROUTE}.` },
  publication_authority_changed: { status: 403, message: "The publication's original human/objective authority does not match the current boundary; use fresh human scope review" },
  recommendation_not_found: { status: 409, message: "No recommendation in this campaign has the published title's subject." },
  recommendation_not_accepted: { status: 409, message: "The publication's recommendation is missing, not accepted, or a duplicate; accept it before admitting scope." },
  resulting_issue_mismatch: { status: 409, message: "Record the verified published issue on exactly one accepted recommendation before admitting scope" },
  origin_outside_scope: { status: 409, message: "The published follow-up's authorized origins were removed from scope" },
  payload_mismatch: { status: 409, message: "The published issue does not match the exact approved payload." },
  payload_title_mismatch: { status: 409, message: "The published issue's title differs from the approved title." },
  payload_body_mismatch: { status: 409, message: "The published issue's body differs from the approved body, beyond trailing whitespace." },
  payload_labels_mismatch: { status: 409, message: "The published issue's labels differ from the approved labels." },
  payload_read_failed: { status: 409, message: "The published issue could not be read and verified against the approved payload." },
  selection_not_granted: { status: 403, message: "Selection lineage needs a scope grant in which the owner's first message asked the campaign to choose " +
    `issues, and this campaign's grant has none. Name a human-authorized epic or the consumed publication of an accepted follow-up, or ${HUMAN_SCOPE_ROUTE}.` },
  selection_additions_only: { status: 400, message: "A selection proposal adds issues only; propose removals as their own change." },
  selection_launch_repository_only: { status: 409, message: "A selection fills only the launch repository's part of the scope, so it can't add an " +
    "issue in another of the campaign's repositories. The campaign's owner can add that issue from Campaign Status." },
  repository_outside_boundary: { status: 403, message: "A proposed issue is not in a repository in this campaign's boundary; " +
    "propose issues from the campaign's own repositories. If the campaign's Project has a Location of that repository, ask the " +
    "campaign's owner to add it with request_campaign_repository_addition, then retry once the addition is carried out." },
  not_an_issue: { status: 409, message: "A proposed number is a pull request, not an issue; propose issues only." },
  issue_not_open: { status: 409, message: "A proposed issue is closed; propose open issues only." },
  already_in_scope: { status: 409, message: "A proposed issue is already in this campaign's scope." },
  other_campaign_scope: { status: 409, message: "A proposed issue is in another active campaign's scope or work; choose another issue." },
  selection_count_exhausted: { status: 409, message: "This proposal would select more issues than the owner's selection count allows. " +
    "Only the owner can change that count, in Campaign Status; an Orchestrator can't." },
  human_required_label: { status: 403, message: "A proposed issue has a label that a Human Required rule names, so only the campaign owner " +
    "can add it; choose another issue or ask the owner to propose it from Campaign Status." },
  owner_named_not_in_message: { status: 409, message: "A proposed issue is marked as named by the owner, but the owner's message doesn't " +
    "write its number for that issue's repository; a bare number means the launch repository. Mark it as your own choice, with your rationale, or leave it out." },
  repository_name_not_in_message: { status: 409, message: "The proposal names a repository the owner's message doesn't write. " +
    "Send the message's own words for each repository, or leave repositoryNames out." },
  repository_constraint_mismatch: { status: 409, message: "A proposed issue is outside the repositories the owner's message limits the work to; " +
    "propose issues from those repositories only." },
  proposal_additions_only: { status: 400, message: "A scope proposal adds issues only; propose removals as their own change." },
  proposal_count_exceeded: { status: 409, message: "The proposal chooses more issues than the owner's count allows: the count the owner " +
    "stated, the campaign's admitted count, or 3 when the owner stated none. Choose fewer issues." },
  requested_all_not_in_message: { status: 409, message: "The proposal asks for all matching issues, but the owner’s message writes neither all nor every." },
  requested_count_not_in_message: { status: 409, message: "The proposal's count isn't written in the owner's message, as digits or a " +
    "word. Give the count the owner wrote, or null when the message states none." },
  constraint_check_refused: { status: 409, message: "The Decision Model found that this proposal doesn't stay within what the owner's " +
    "message allows. Revise it and propose again; proposing the same issues with another rationale gets the same answer." },
};

/** The accepted recommendation a consumed publication delivered as `issue`. A bounded grant names it.
 * A person-approved publication may name it too, as its requester sent it (#3918). Either way it
 * binds only to exactly one accepted, non-duplicate recommendation of this campaign in the payload's
 * repository that records `issue` as its result and whose title has the approved payload's subject:
 * a name narrows that match and never replaces it. */
export function scopePublicationRecommendation(db: ControlPlaneDb, rootId: string, publication: Extract<WorkflowDecisionResourceSnapshot, { category: "follow_up_issue_publication" }>,
  issue: number): { recommendation: CampaignRecommendation } | { failure: CampaignScopeAdmissionFailure } {
  const usable = (r: CampaignRecommendation) => r.disposition === "accepted" && !r.duplicateOfId;
  const delivered = (r: CampaignRecommendation) => r.resultingIssue?.number === issue && r.resultingIssue.repository.toLowerCase() === publication.repository;
  const subject = campaignPublicationTitle(publication.sanitizedTitle);
  const titledAs = (r: CampaignRecommendation) => r.repository.toLowerCase() === publication.repository && campaignPublicationTitle(r.title) === subject;
  if (publication.recommendationId) {
    const named = db.campaignWorkLedger.recommendation(rootId, publication.recommendationId);
    if (named && !titledAs(named)) return { failure: "recommendation_not_found" };
    if (!named || !usable(named)) return { failure: "recommendation_not_accepted" };
    return delivered(named) ? { recommendation: named } : { failure: "resulting_issue_mismatch" };
  }
  const titled = db.campaignWorkLedger.recommendations(rootId).filter(titledAs);
  if (!titled.length) return { failure: "recommendation_not_found" };
  const accepted = titled.filter(usable);
  if (!accepted.length) return { failure: "recommendation_not_accepted" };
  const matches = accepted.filter(delivered);
  return matches.length === 1 ? { recommendation: matches[0]! } : { failure: "resulting_issue_mismatch" };
}

/** The publications a scope change admits: its follow-up lineage and the exact payloads it verified. */
export function scopeSettlements(snapshot: Extract<WorkflowDecisionResourceSnapshot, { category: "campaign_issue_scope" }>): string[] {
  // Exactly the proofs `admittedCampaignPublicationIssue` accepts once this change is consumed: a
  // lineage alone is a caller's claim and settles nothing without the server's issue admission.
  const lineage = snapshot.lineage?.kind === "follow_up" && typeof snapshot.issueAdmission === "object" && snapshot.issueAdmission !== null &&
    snapshot.additions.length === 1 ? snapshot.lineage.publicationOccurrenceId : undefined;
  return [...(lineage ? [lineage] : []), ...(snapshot.verifiedPublications ?? []).map((proof) => proof.publicationOccurrenceId)];
}

export function reservedPublicationSlots(db: ControlPlaneDb, root: SessionView, exceptOccurrence?: string, exceptRecommendation?: string, consumedOnly = false): number {
  const recommendations = new Set<string>();
  for (const d of db.campaignPublicationReservations(root.id)) {
    if (d.occurrenceId === exceptOccurrence || d.resourceSnapshot.category !== "follow_up_issue_publication" || consumedOnly && d.status !== "consumed") continue;
    const id = d.resourceSnapshot.recommendationId;
    if (id && id === exceptRecommendation) continue;
    // A recommendation's resultingIssue is mutable agent ledger prose. Only consumption of
    // the independently inspected publication-lineage scope decision can settle this slot.
    if (db.admittedCampaignPublicationIssue(root.id, d.occurrenceId) === null) recommendations.add(id ?? d.occurrenceId);
  }
  return recommendations.size;
}

type DeliveryCandidate = ForgeFactEntry & { approvedHeads: string[] };

/** #4120: the repositories whose merged pull requests may prove a closure in `repository`: that
 * repository and every other one in the campaign's boundary. Pull requests anywhere else stay
 * `pull_request_outside_repository`. */
function proofRepositories(root: SessionView, repository: string | undefined): Set<string> {
  return new Set([...(repository ? [repository.toLowerCase()] : []), ...campaignScopeRepositories(root).map((entry) => entry.repository.toLowerCase())]);
}

/** The pull requests that may prove one item's delivery (#2940): every consumed `pr_merge` gate a
 * verified-delivered attempt's session passed inside that attempt (server-recorded at an exact
 * head), and every pull request the item's reported stage names. Each is only a candidate; its
 * forge fact decides. A gate from before the attempt began or after its verified report, or one
 * meant to close neither this item's issue nor the fixed-by target, belongs to other work. */
function deliveryCandidates(db: ControlPlaneDb, root: SessionView, item: CampaignWorkItemDetail, closureIssue: number, closureRepository: string | undefined): DeliveryCandidate[] {
  const candidates = new Map<string, DeliveryCandidate>();
  for (const entry of item.observed.pullRequests ?? []) candidates.set(forgeRefKey(entry.ref), { ...entry, approvedHeads: [] });
  const repository = closureRepository?.toLowerCase();
  const issue = item.issue ? `${item.issue.repository}#${item.issue.number}`.toLowerCase() : null;
  const target = `${repository}#${closureIssue}`;
  const windows = (item.verifications ?? []).flatMap((v) => {
    const attempt = v.outcome === "delivered" ? (item.attempts ?? []).find((a) => a.id === v.attemptId) : undefined;
    const until = v.report.ts ?? attempt?.endedAt;
    return attempt?.sessionId && attempt.sessionId === v.childSessionId && until !== null && until !== undefined
      ? [{ sessionId: attempt.sessionId, from: attempt.startedAt, until }] : [];
  });
  const gated = new Map<string, { ref: CampaignPullRequestRef; heads: string[] }>();
  const proof = proofRepositories(root, repository);
  for (const decision of db.consumedPullRequestMerges(windows.map((w) => w.sessionId))) {
    const gate = decision.resourceSnapshot;
    if (gate.category !== "pr_merge" || !proof.has(gate.repository.toLowerCase()) ||
        !windows.some((w) => w.sessionId === decision.sessionId && decision.createdAt >= w.from && decision.createdAt <= w.until) ||
        gate.intendedClosures?.length && !gate.intendedClosures.some((closure) =>
          closure.toLowerCase() === issue || closure.toLowerCase() === target)) continue;
    const ref = { repository: gate.repository, number: gate.pullRequest };
    const key = forgeRefKey(ref);
    gated.set(key, { ref, heads: [...(gated.get(key)?.heads ?? []), gate.headSha] });
  }
  const unseen = [...gated.values()].filter(({ ref }) => !candidates.has(forgeRefKey(ref))).map(({ ref }) => ref);
  for (const entry of db.campaignForgeObservations.facts(root.id, unseen, Date.now())) candidates.set(forgeRefKey(entry.ref), { ...entry, approvedHeads: [] });
  for (const [key, { heads }] of gated) candidates.get(key)!.approvedHeads = heads;
  return [...candidates.values()];
}

/** Every pull request a completed closure of this issue would read, for an on-demand refresh. One in
 * a repository outside the proof's (#4120) is left out: no runner holding a Location of that
 * repository could read it, and the root's login never stands in. The proof still names it as a gap. */
export function closureCandidateRefs(db: ControlPlaneDb, root: SessionView, issue: number,
  repository: string | undefined = root.orchestratorPolicy?.issueScope?.repository): CampaignPullRequestRef[] {
  const proof = proofRepositories(root, repository?.toLowerCase());
  const refs = new Map<string, CampaignPullRequestRef>();
  for (const item of issueWork(db, root, issue, repository)) for (const { ref } of deliveryCandidates(db, root, item, issue, repository)) {
    if (proof.has(ref.repository.toLowerCase())) refs.set(forgeRefKey(ref), ref);
  }
  return [...refs.values()];
}

/** The candidates a closure proof excluded as closed without merging, which execution re-reads uncached. */
export function closureExcludedRefs(proof: ReturnType<typeof closureEvidence>): CampaignPullRequestRef[] {
  const excluded = proof && "excluded" in proof ? proof.excluded ?? [] : [];
  return excluded.map((key) => ({ repository: key.slice(0, key.lastIndexOf("#")), number: Number(key.slice(key.lastIndexOf("#") + 1)) }));
}

/** The candidates freshly observed merged, for the runner to re-verify at their exact heads. */
export function closureDeliveryPullRequests(db: ControlPlaneDb, root: SessionView, issue: number,
  repository: string | undefined = root.orchestratorPolicy?.issueScope?.repository) {
  const delivery = new Map<number, { number: number; headSha: string; mergeCommitSha: string }>();
  for (const item of issueWork(db, root, issue, repository)) for (const { ref, fact } of deliveryCandidates(db, root, item, issue, repository)) {
    // The closure repository's runner verifies only its own repository's pull requests (#4120).
    if (ref.repository.toLowerCase() === repository?.toLowerCase() &&
        fact.availability === "fresh" && fact.value.state === "merged" && fact.value.mergeCommitSha) {
      delivery.set(ref.number, { number: ref.number, headSha: fact.value.headSha, mergeCommitSha: fact.value.mergeCommitSha });
    }
  }
  return [...delivery.values()];
}

/** #4120: the candidates in the campaign's other repositories freshly observed merged, for an
 * authoritative read through a Location of each one's own repository. */
export function closureCrossRepositoryPullRequests(db: ControlPlaneDb, root: SessionView, issue: number,
  repository: string | undefined = root.orchestratorPolicy?.issueScope?.repository): CampaignPullRequestRef[] {
  const proof = proofRepositories(root, repository);
  const own = repository?.toLowerCase();
  const refs = new Map<string, CampaignPullRequestRef>();
  for (const item of issueWork(db, root, issue, repository)) for (const { ref, fact } of deliveryCandidates(db, root, item, issue, repository)) {
    const named = ref.repository.toLowerCase();
    if (named !== own && proof.has(named) && fact.availability === "fresh" && fact.value.state === "merged" && fact.value.mergeCommitSha) {
      refs.set(forgeRefKey(ref), { repository: ref.repository, number: ref.number });
    }
  }
  return [...refs.values()];
}

/** #4120: an authoritative read's answer as the snapshot's cross-repository delivery: each pull
 * request read MERGED, with its head and merge commit, in the order asked. Undefined when the read
 * did not answer for every one, which proves none of them. */
export function closureCrossRepositoryDelivery(refs: readonly CampaignPullRequestRef[],
  results: ReadonlyArray<{ ref: CampaignPullRequestRef; observation?: CampaignForgeChangeRequestObservation }> | null): GithubIssueClosureSnapshot["crossRepositoryDelivery"] {
  if (!refs.length || !results || results.length !== refs.length) return undefined;
  // Merged into that repository's default branch, as a recorded delivery requires (#4070): the forge
  // must name its default branch (a GitLab merge request, or an older runner's read, names none and
  // proves nothing) and the pull request's base must be it.
  const delivered = results.flatMap(({ ref, observation }) => observation && observation.forge === undefined && observation.state === "merged" &&
    observation.mergeCommitSha && observation.defaultBranch && observation.baseRef === observation.defaultBranch
    ? [{ repository: ref.repository.toLowerCase(), number: ref.number, headSha: observation.headSha, mergeCommitSha: observation.mergeCommitSha }] : []);
  return delivered.length ? delivered : undefined;
}

/** Delivery is an independently verified report plus observed forge merges. Stage prose alone,
 * an enqueued PR, a stale observation, or a ledger insertion is never delivery evidence. A
 * candidate freshly observed closed without merging is excluded rather than disqualifying, but
 * every item still needs one fresh, runner-verified merge, at an approved head when gated. A
 * snapshot carrying the runner's member read is proven from the epic's members instead (#4060). */
export function closureEvidence(db: ControlPlaneDb, root: SessionView, snapshot: GithubIssueClosureSnapshot) {
  const boundary = issueBoundary(root);
  // #4119: that repository's boundary entry; operations and reasons stay campaign-wide.
  if (!boundary?.issueAuthority?.closureReasons.includes(snapshot.reason) || !boundary.operations.includes("issue_closure") ||
      !campaignBoundaryRepository(boundary, snapshot.repository) || snapshot.openPullRequests.length ||
      !campaignClosureIssueHeld(root.orchestratorPolicy, { repository: snapshot.repository, number: snapshot.issue })) return null;
  if (snapshot.epicMembers) return epicMemberEvidence(db, root, snapshot);
  const items = issueWork(db, root, snapshot.issue, snapshot.repository);
  // Fixed-by evidence is completion-only; it cannot cancel another issue's units.
  if (snapshot.reason !== "completed" && db.campaignWorkLedger.fixedBy(root.id, snapshot.repository, snapshot.issue)) return null;
  if (snapshot.reason === "not_planned") {
    const disposition = snapshot.dispositionRecommendationId && db.campaignWorkLedger.recommendation(root.id, snapshot.dispositionRecommendationId);
    if (snapshot.dispositionRecommendationId && (!disposition || !["rejected", "duplicate"].includes(disposition.disposition) || !disposition.dispositionReason ||
        !items.some((item) => disposition.originWorkItemIds.includes(item.id)))) return null;
    if (!items.length || items.some((item) => !["cancelled", "scope_removed"].includes(item.commitment) || item.currentAttempt ||
        !item.commitmentRecord.reason || !item.commitmentRecord.changedBySessionId)) return null;
    return { disposition: disposition || null, items: items.map((item) => ({ id: item.id, commitmentRecord: item.commitmentRecord })) };
  }
  const excluded = new Set<string>();
  if (!items.length || items.some((item) => !itemDelivered(db, root, item, snapshot, excluded))) return null;
  return { items: items.map((item) => ({ id: item.id, verifications: item.verifications })), delivery: snapshot.delivery,
    ...(snapshot.crossRepositoryDelivery ? { crossRepositoryDelivery: snapshot.crossRepositoryDelivery } : {}),
    ...(excluded.size ? { excluded: [...excluded].sort() } : {}) };
}

/** Whether a merged pull request's merge was verified for this snapshot: by the closure repository's
 * runner at its exact head, or, for another campaign repository's (#4120), by an authoritative read
 * through a Location of that repository just before the request. */
function deliveryVerified(snapshot: GithubIssueClosureSnapshot, ref: CampaignPullRequestRef, headSha: string, mergeCommitSha: string): boolean {
  const repository = ref.repository.toLowerCase();
  const verified = repository === snapshot.repository.toLowerCase() ? snapshot.delivery
    : snapshot.crossRepositoryDelivery?.filter((delivered) => delivered.repository.toLowerCase() === repository);
  return Boolean(verified?.some((delivered) => delivered.number === ref.number && delivered.headSha === headSha && delivered.mergeCommitSha === mergeCommitSha));
}

/** One item's delivery proof: a delivered verification with an exact report digest, no open
 * attempt, and at least one fresh merge verified for it, at an approved head when gated. A pull
 * request in another of the campaign's repositories counts (#4120); one anywhere else disproves it. */
function itemDelivered(db: ControlPlaneDb, root: SessionView, item: CampaignWorkItemDetail, snapshot: GithubIssueClosureSnapshot,
  excluded: Set<string>): boolean {
  if (item.primaryState !== "delivered" || item.currentAttempt || !item.verifications.some((v) => v.outcome === "delivered" && v.report.digest)) return false;
  const proof = proofRepositories(root, snapshot.repository);
  let merged = 0;
  for (const { ref, fact, approvedHeads } of deliveryCandidates(db, root, item, snapshot.issue, snapshot.repository)) {
    if (!proof.has(ref.repository.toLowerCase()) || fact.availability !== "fresh") return false;
    if (fact.value.state === "closed") { excluded.add(forgeRefKey(ref)); continue; }
    const value = fact.value;
    if (value.state !== "merged" || !value.mergeCommitSha || approvedHeads.length && !approvedHeads.includes(value.headSha) ||
        !deliveryVerified(snapshot, ref, value.headSha, value.mergeCommitSha)) return false;
    merged++;
  }
  return merged > 0;
}

/** The ledger proves absence of delivery work, including erased stages. Titles prove nothing.
 * Inconsistent or missing attempt detail cannot expand the exception. */
export const epicPlaceholderItem = (db: ControlPlaneDb, root: SessionView, item: CampaignWorkItemDetail) =>
  !item.currentAttempt && item.attemptCount === item.attempts.length && db.campaignWorkLedger.epicTrackingItem(root.id, item.id);

/** Whether the epic source may prove this closure (#4060): a completed closure of an issue with no
 * fixed-by plan. A recorded plan stays the issue's proof, and a not-planned closure keeps its own. */
export function epicSourceApplies(db: ControlPlaneDb, root: SessionView, snapshot: Pick<GithubIssueClosureSnapshot, "reason" | "repository" | "issue">): boolean {
  return snapshot.reason === "completed" && !db.campaignWorkLedger.fixedBy(root.id, snapshot.repository, snapshot.issue);
}

/** The epic source (#4060): an in-scope epic proven from its members, which the runner read on the
 * forge at request time from the sources scope admission accepts and bound into the forge digest;
 * agent text never names one. Every member must be in the campaign's scope and closed as completed.
 * An open member is not proven here even when its own closure would be, so an epic never closes
 * ahead of a member: closing the member first is the route. The epic's own work items still count,
 * each delivered under the ordinary proof, except server-derived epic tracking work. An
 * issue without members keeps the ordinary proof. */
function epicMemberEvidence(db: ControlPlaneDb, root: SessionView, snapshot: GithubIssueClosureSnapshot) {
  const read = snapshot.epicMembers;
  if (!read?.readable || !read.members.length || !epicSourceApplies(db, root, snapshot) ||
      read.members.some((member) => member.state !== "completed" ||
        !campaignClosureIssueHeld(root.orchestratorPolicy, { repository: snapshot.repository, number: member.number }))) return null;
  const own = trackedIssueWork(db, root, snapshot.issue, snapshot.repository);
  if (!own) return null;
  const excluded = new Set<string>();
  const placeholders = own.filter((item) => epicPlaceholderItem(db, root, item)).map((item) => item.id);
  const items = own.filter((item) => !placeholders.includes(item.id));
  if (items.some((item) => !itemDelivered(db, root, item, snapshot, excluded))) return null;
  return { source: "epic_members" as const, members: read.members.map((member) => ({ ...member })), placeholders,
    items: items.map((item) => ({ id: item.id, verifications: item.verifications })), delivery: snapshot.delivery,
    ...(snapshot.crossRepositoryDelivery ? { crossRepositoryDelivery: snapshot.crossRepositoryDelivery } : {}),
    ...(excluded.size ? { excluded: [...excluded].sort() } : {}) };
}

/** Every gap between a closure and delegated proof (#4058), or null when the boundary does not
 * delegate this closure at all, which stays `outside_boundary`. It reads the same ledger, gates and
 * forge facts as `closureEvidence`, but only to name what failed: `closureEvidence` never consults
 * it, so a gap list can neither prove a closure nor loosen any condition of the proof. A request
 * that fails the proof always gets at least one gap (`delivery_unverified` when no other applies).
 * A snapshot proven from an epic's members gets that source's gaps (#4060); `membersUnreadable`
 * says the runner was asked for the members of a snapshot without them and could not read them. */
export function closureDeliveryGaps(db: ControlPlaneDb, root: SessionView, snapshot: GithubIssueClosureSnapshot,
  checked: { proven: boolean; commentSafe: boolean; membersUnreadable?: boolean }): IssueClosureDeliveryGap[] | null {
  const boundary = issueBoundary(root);
  if (!boundary?.issueAuthority?.closureReasons.includes(snapshot.reason) || !boundary.operations.includes("issue_closure") ||
      !campaignBoundaryRepository(boundary, snapshot.repository) ||
      !campaignClosureIssueHeld(root.orchestratorPolicy, { repository: snapshot.repository, number: snapshot.issue })) return null;
  const gaps: IssueClosureDeliveryGap[] = [];
  const add: AddGap = (code, details = {}) => {
    if (gaps.length < ISSUE_CLOSURE_DELIVERY_GAPS_MAX) gaps.push(issueClosureDeliveryGap(code, details));
  };
  if (!checked.proven && snapshot.epicMembers) epicGapsInto(db, root, snapshot, add, () => gaps.length);
  else if (!checked.proven) {
    deliveryGapsInto(db, root, snapshot, add, () => gaps.length);
    if (checked.membersUnreadable) add("epic_members_unreadable");
  }
  if (!checked.commentSafe) add("comment_unsafe");
  if (!gaps.length) add("delivery_unverified");
  return gaps;
}

type AddGap = (code: IssueClosureDeliveryGapCode, details?: { verificationFailure?: GithubIssueClosureSnapshot["deliveryVerificationFailure"]; workItemId?: string; pullRequests?: number[]; members?: number[]; repository?: string }) => void;

function deliveryGapsInto(db: ControlPlaneDb, root: SessionView, snapshot: GithubIssueClosureSnapshot, add: AddGap, count: () => number): void {
  // Open related PRs block every reason. A PR whose title and body no longer mention the issue still
  // counts while GitHub's timeline cross-references it: only its merge or closure ends that (#4058).
  if (snapshot.openPullRequests.length) add("open_related_pull_requests", { pullRequests: snapshot.openPullRequests.map((pr) => pr.number) });
  const relationship = db.campaignWorkLedger.fixedBy(root.id, snapshot.repository, snapshot.issue);
  if (relationship && snapshot.reason !== "completed") add("fixed_by_completion_only");
  const items: CampaignWorkItemDetail[] = [];
  for (const id of relationship ?? []) {
    const item = db.campaignWorkLedger.detail(root.id, id, Date.now());
    if (!item) { add("missing_work_item", { workItemId: id }); continue; }
    if (!item.issue || item.issue.repository.toLowerCase() !== snapshot.repository.toLowerCase() ||
        !campaignClosureIssueHeld(root.orchestratorPolicy, item.issue)) { add("work_item_outside_scope", { workItemId: id }); continue; }
    items.push(item);
  }
  const tracked = trackedIssueWork(db, root, snapshot.issue, snapshot.repository);
  if (!tracked) return add("delivery_unverified");
  for (const item of tracked) if (!items.some((existing) => existing.id === item.id)) items.push(item);
  if (!items.length) {
    // A not-planned closure needs a recorded disposition, which needs a cancelled or removed item.
    if (!relationship?.length) add(snapshot.reason === "not_planned" ? "disposition_unverified" : "no_work_item");
    return;
  }
  if (snapshot.reason === "not_planned") {
    const disposition = snapshot.dispositionRecommendationId && db.campaignWorkLedger.recommendation(root.id, snapshot.dispositionRecommendationId);
    if (snapshot.dispositionRecommendationId && (!disposition || !["rejected", "duplicate"].includes(disposition.disposition) || !disposition.dispositionReason ||
        !items.some((item) => disposition.originWorkItemIds.includes(item.id)))) add("disposition_unverified");
    for (const item of items) if (!["cancelled", "scope_removed"].includes(item.commitment) || item.currentAttempt ||
        !item.commitmentRecord.reason || !item.commitmentRecord.changedBySessionId) add("disposition_unverified", { workItemId: item.id });
    return;
  }
  itemGapsInto(db, root, snapshot, items, add, count);
}

/** The epic source's gaps (#4060), each naming its members or work item: members outside scope,
 * then open, closed-otherwise and unreadable members, then the epic's own dispatched items under
 * the ordinary per-item conditions. A placeholder item is never a gap here. */
function epicGapsInto(db: ControlPlaneDb, root: SessionView, snapshot: GithubIssueClosureSnapshot, add: AddGap, count: () => number): void {
  if (snapshot.openPullRequests.length) add("open_related_pull_requests", { pullRequests: snapshot.openPullRequests.map((pr) => pr.number) });
  const read = snapshot.epicMembers!;
  if (!read.readable) return add("epic_members_unreadable");
  if (!epicSourceApplies(db, root, snapshot)) return add("delivery_unverified");
  const inScope = (number: number) => campaignClosureIssueHeld(root.orchestratorPolicy, { repository: snapshot.repository, number });
  const named = (keep: (member: IssueClosureEpicMembers["members"][number]) => boolean) => read.members.filter(keep).map((member) => member.number);
  const outside = named((member) => !inScope(member.number));
  if (outside.length) add("epic_member_outside_scope", { members: outside });
  for (const [state, code] of [["open", "epic_member_open"], ["closed_not_completed", "epic_member_not_completed"],
    ["unreadable", "epic_member_unreadable"]] as const) {
    const members = named((member) => inScope(member.number) && member.state === state);
    if (members.length) add(code, { members });
  }
  const own = trackedIssueWork(db, root, snapshot.issue, snapshot.repository);
  if (!own) return add("delivery_unverified");
  const ordinary: CampaignWorkItemDetail[] = [];
  for (const item of own) {
    if (epicPlaceholderItem(db, root, item)) continue;
    if (db.campaignWorkLedger.epicTrackingHistoryUnavailable(root.id, item.id)) {
      add("epic_tracking_history_unavailable", { workItemId: item.id });
    } else ordinary.push(item);
  }
  itemGapsInto(db, root, snapshot, ordinary, add, count);
}

function itemGapsInto(db: ControlPlaneDb, root: SessionView, snapshot: GithubIssueClosureSnapshot, items: CampaignWorkItemDetail[],
  add: AddGap, count: () => number): void {
  // The runner confirms merges only once everything else holds, so an unconfirmed merge is a gap of
  // its own only when nothing else is: otherwise the runner was never asked.
  const unconfirmed: Array<{ workItemId: string; pullRequests: number[]; repository?: string }> = [];
  for (const item of items) {
    if (item.currentAttempt) {
      add(item.stateCauses.includes("attempt_awaiting_verification") ? "attempt_awaiting_verification" : "attempt_open", { workItemId: item.id });
      continue;
    }
    if (!item.verifications.some((v) => v.outcome === "delivered" && v.report.digest)) { add("no_delivered_verification", { workItemId: item.id }); continue; }
    if (item.primaryState !== "delivered") { add("work_item_not_delivered", { workItemId: item.id }); continue; }
    const before = count();
    const own = snapshot.repository.toLowerCase();
    const proof = proofRepositories(root, own);
    const outside: number[] = [];
    // #4120: per repository, the closure's own first, so another repository's pull requests are named by it.
    const byRepository = new Map<string, { stale: number[]; open: number[]; wrongHead: number[]; unverified: number[] }>([[own, { stale: [], open: [], wrongHead: [], unverified: [] }]]);
    let merged = 0;
    for (const { ref, fact, approvedHeads } of deliveryCandidates(db, root, item, snapshot.issue, snapshot.repository)) {
      const repository = ref.repository.toLowerCase();
      if (!proof.has(repository)) { outside.push(ref.number); continue; }
      if (!byRepository.has(repository)) byRepository.set(repository, { stale: [], open: [], wrongHead: [], unverified: [] });
      const lists = byRepository.get(repository)!;
      if (fact.availability !== "fresh") lists.stale.push(ref.number);
      else if (fact.value.state === "closed") continue;
      else if (fact.value.state !== "merged" || !fact.value.mergeCommitSha) lists.open.push(ref.number);
      else if (approvedHeads.length && !approvedHeads.includes(fact.value.headSha)) lists.wrongHead.push(ref.number);
      else if (!deliveryVerified(snapshot, ref, fact.value.headSha, fact.value.mergeCommitSha)) lists.unverified.push(ref.number);
      else merged++;
    }
    if (outside.length) add("pull_request_outside_repository", { workItemId: item.id, pullRequests: outside });
    let unverifiedAny = false;
    for (const [repository, lists] of byRepository) {
      const named = repository === own ? {} : { repository };
      if (lists.stale.length) add("stale_pull_request", { workItemId: item.id, pullRequests: lists.stale, ...named });
      if (lists.open.length) add("unmerged_pull_request", { workItemId: item.id, pullRequests: lists.open, ...named });
      if (lists.wrongHead.length) add("delivery_not_verified_at_exact_head", { workItemId: item.id, pullRequests: lists.wrongHead, ...named });
      if (lists.unverified.length) {
        unverifiedAny = true;
        unconfirmed.push({ workItemId: item.id, pullRequests: lists.unverified, ...named });
      }
    }
    if (!unverifiedAny && !merged && count() === before) add("no_merged_delivery_pull_request", { workItemId: item.id });
  }
  if (!count()) for (const gap of unconfirmed) add("delivery_merge_unconfirmed", { ...gap, verificationFailure: snapshot.deliveryVerificationFailure });
}
