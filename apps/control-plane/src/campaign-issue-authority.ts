import { createHash } from "node:crypto";
import { campaignPublicationSafe, campaignPublicationTitle, type CampaignPublicationAdmissionFailure, type SessionView, type GithubIssueClosureSnapshot,
  type WorkflowDecisionResourceSnapshot, type CampaignWorkItemDetail, type CampaignPullRequestRef } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { campaignBoundaryCurrent } from "./campaign-authority.js";
import { forgeRefKey, type ForgeFactEntry } from "./campaign-forge-observations.js";

export const issueEvidenceDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

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

export function issueBoundary(root: SessionView) {
  const control = root.orchestratorPolicy?.control;
  return control?.mode === "full_control" && campaignBoundaryCurrent(root) && control.boundary.issueAuthority ? control.boundary : null;
}

export function issueWork(db: ControlPlaneDb, root: SessionView, issue: number): CampaignWorkItemDetail[] {
  const items: CampaignWorkItemDetail[] = [];
  let cursor: string | undefined;
  do {
    const page = db.campaignWorkLedger.page(root.id, { state: "all", limit: 100, ...(cursor ? { cursor } : {}) }, Date.now());
    if (!page.ok) return [];
    for (const item of page.data.items) if (item.issue?.number === issue &&
        item.issue.repository.toLowerCase() === root.orchestratorPolicy?.issueScope?.repository.toLowerCase()) {
      const detail = db.campaignWorkLedger.detail(root.id, item.id, Date.now());
      if (detail) items.push(detail);
    }
    cursor = page.data.nextCursor ?? undefined;
  } while (cursor);
  return items;
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
  if (!boundary?.issueAuthority?.relatedFollowUps || !boundary.operations.includes(snapshot.category) ||
      snapshot.repository !== boundary.repository.toLowerCase()) return failed("no_issue_boundary");
  if (!snapshot.recommendationId) return failed("recommendation_not_found");
  if (!campaignPublicationSafe(snapshot.sanitizedTitle, snapshot.sanitizedBody, snapshot.labels)) return failed("unsafe_payload");
  const recommendation = db.campaignWorkLedger.recommendation(root.id, snapshot.recommendationId);
  if (!recommendation || recommendation.repository.toLowerCase() !== snapshot.repository) return failed("recommendation_not_found");
  if (recommendation.disposition !== "accepted" || recommendation.duplicateOfId || !recommendation.dispositionReason) return failed("recommendation_not_accepted");
  if (recommendation.publication !== "awaiting_publication") return failed("recommendation_spent");
  if (campaignPublicationTitle(recommendation.title) !== campaignPublicationTitle(snapshot.sanitizedTitle)) return failed("title_mismatch");
  if (!recommendation.originWorkItemIds.length) return failed("origin_outside_scope");
  const origins = recommendation.originWorkItemIds.map((id) => db.campaignWorkLedger.detail(root.id, id, Date.now())?.issue);
  if (origins.some((issue) => !issue || issue.repository.toLowerCase() !== snapshot.repository || !root.orchestratorPolicy?.issueNumbers?.includes(issue.number))) return failed("origin_outside_scope");
  // Scope capacity includes every outstanding publication reservation, so concurrent approvals
  // cannot consume the same final slot. This hook composes with aggregate campaign limits.
  const grants = db.campaignPublicationReservations(root.id);
  if (grants.some((d) => d.status === "consumed" && d.resourceSnapshot.category === snapshot.category && d.resourceSnapshot.recommendationId === snapshot.recommendationId)) return failed("recommendation_spent");
  const reservations = reservedPublicationSlots(db, root, undefined, snapshot.recommendationId);
  if ((root.orchestratorPolicy?.issueNumbers?.length ?? 0) + reservations >= boundary.issueAuthority.maxIssues) return failed("capacity_exhausted");
  return { evidence: { recommendation, origins, scopeRevision: boundary.issueScopeRevision, boundaryRevision: boundary.revision } };
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

/** The pull requests that may prove one item's delivery (#2940): every consumed `pr_merge` gate a
 * verified-delivered attempt's session passed inside that attempt (server-recorded at an exact
 * head), and every pull request the item's reported stage names. Each is only a candidate; its
 * forge fact decides. A gate from before the attempt began or after its verified report, or one
 * meant to close other issues but not this item's, belongs to other work and is never counted. */
function deliveryCandidates(db: ControlPlaneDb, root: SessionView, item: CampaignWorkItemDetail): DeliveryCandidate[] {
  const candidates = new Map<string, DeliveryCandidate>();
  for (const entry of item.observed.pullRequests ?? []) candidates.set(forgeRefKey(entry.ref), { ...entry, approvedHeads: [] });
  const repository = root.orchestratorPolicy?.issueScope?.repository.toLowerCase();
  const issue = item.issue ? `${item.issue.repository}#${item.issue.number}`.toLowerCase() : null;
  const windows = (item.verifications ?? []).flatMap((v) => {
    const attempt = v.outcome === "delivered" ? (item.attempts ?? []).find((a) => a.id === v.attemptId) : undefined;
    const until = v.report.ts ?? attempt?.endedAt;
    return attempt?.sessionId && attempt.sessionId === v.childSessionId && until !== null && until !== undefined
      ? [{ sessionId: attempt.sessionId, from: attempt.startedAt, until }] : [];
  });
  const gated = new Map<string, { ref: CampaignPullRequestRef; heads: string[] }>();
  for (const decision of db.consumedPullRequestMerges(windows.map((w) => w.sessionId))) {
    const gate = decision.resourceSnapshot;
    if (gate.category !== "pr_merge" || gate.repository.toLowerCase() !== repository ||
        !windows.some((w) => w.sessionId === decision.sessionId && decision.createdAt >= w.from && decision.createdAt <= w.until) ||
        gate.intendedClosures?.length && (!issue || !gate.intendedClosures.some((closure) => closure.toLowerCase() === issue))) continue;
    const ref = { repository: gate.repository, number: gate.pullRequest };
    const key = forgeRefKey(ref);
    gated.set(key, { ref, heads: [...(gated.get(key)?.heads ?? []), gate.headSha] });
  }
  const unseen = [...gated.values()].filter(({ ref }) => !candidates.has(forgeRefKey(ref))).map(({ ref }) => ref);
  for (const entry of db.campaignForgeObservations.facts(root.id, unseen, Date.now())) candidates.set(forgeRefKey(entry.ref), { ...entry, approvedHeads: [] });
  for (const [key, { heads }] of gated) candidates.get(key)!.approvedHeads = heads;
  return [...candidates.values()];
}

/** Every pull request a completed closure of this issue would read, for an on-demand refresh. */
export function closureCandidateRefs(db: ControlPlaneDb, root: SessionView, issue: number): CampaignPullRequestRef[] {
  const refs = new Map<string, CampaignPullRequestRef>();
  for (const item of issueWork(db, root, issue)) for (const { ref } of deliveryCandidates(db, root, item)) refs.set(forgeRefKey(ref), ref);
  return [...refs.values()];
}

/** The candidates a closure proof excluded as closed without merging, which execution re-reads uncached. */
export function closureExcludedRefs(proof: ReturnType<typeof closureEvidence>): CampaignPullRequestRef[] {
  const excluded = proof && "excluded" in proof ? proof.excluded ?? [] : [];
  return excluded.map((key) => ({ repository: key.slice(0, key.lastIndexOf("#")), number: Number(key.slice(key.lastIndexOf("#") + 1)) }));
}

/** The candidates freshly observed merged, for the runner to re-verify at their exact heads. */
export function closureDeliveryPullRequests(db: ControlPlaneDb, root: SessionView, issue: number) {
  const delivery = new Map<number, { number: number; headSha: string; mergeCommitSha: string }>();
  for (const item of issueWork(db, root, issue)) for (const { ref, fact } of deliveryCandidates(db, root, item)) {
    if (fact.availability === "fresh" && fact.value.state === "merged" && fact.value.mergeCommitSha) {
      delivery.set(ref.number, { number: ref.number, headSha: fact.value.headSha, mergeCommitSha: fact.value.mergeCommitSha });
    }
  }
  return [...delivery.values()];
}

/** Delivery is an independently verified report plus observed forge merges. Stage prose alone,
 * an enqueued PR, a stale observation, or a ledger insertion is never delivery evidence. A
 * candidate freshly observed closed without merging is excluded rather than disqualifying, but
 * every item still needs one fresh, runner-verified merge, at an approved head when gated. */
export function closureEvidence(db: ControlPlaneDb, root: SessionView, snapshot: GithubIssueClosureSnapshot) {
  const boundary = issueBoundary(root);
  if (!boundary?.issueAuthority?.closureReasons.includes(snapshot.reason) || !boundary.operations.includes("issue_closure") ||
      snapshot.repository.toLowerCase() !== boundary.repository.toLowerCase() || snapshot.openPullRequests.length ||
      !root.orchestratorPolicy?.issueNumbers?.includes(snapshot.issue)) return null;
  const items = issueWork(db, root, snapshot.issue);
  if (snapshot.reason === "not_planned") {
    const disposition = snapshot.dispositionRecommendationId && db.campaignWorkLedger.recommendation(root.id, snapshot.dispositionRecommendationId);
    if (snapshot.dispositionRecommendationId && (!disposition || !["rejected", "duplicate"].includes(disposition.disposition) || !disposition.dispositionReason ||
        !items.some((item) => disposition.originWorkItemIds.includes(item.id)))) return null;
    if (!items.length || items.some((item) => !["cancelled", "scope_removed"].includes(item.commitment) || item.currentAttempt ||
        !item.commitmentRecord.reason || !item.commitmentRecord.changedBySessionId)) return null;
    return { disposition: disposition || null, items: items.map((item) => ({ id: item.id, commitmentRecord: item.commitmentRecord })) };
  }
  if (!items.length || items.some((item) => item.primaryState !== "delivered" || item.currentAttempt ||
      !item.verifications.some((v) => v.outcome === "delivered" && v.report.digest))) return null;
  const excluded = new Set<string>();
  for (const item of items) {
    let merged = 0;
    for (const { ref, fact, approvedHeads } of deliveryCandidates(db, root, item)) {
      if (ref.repository.toLowerCase() !== snapshot.repository.toLowerCase() || fact.availability !== "fresh") return null;
      if (fact.value.state === "closed") { excluded.add(forgeRefKey(ref)); continue; }
      const value = fact.value;
      if (value.state !== "merged" || !value.mergeCommitSha || approvedHeads.length && !approvedHeads.includes(value.headSha) ||
          !snapshot.delivery?.some((delivered) => delivered.number === ref.number && delivered.headSha === value.headSha &&
            delivered.mergeCommitSha === value.mergeCommitSha)) return null;
      merged++;
    }
    if (!merged) return null;
  }
  return { items: items.map((item) => ({ id: item.id, verifications: item.verifications })), delivery: snapshot.delivery,
    ...(excluded.size ? { excluded: [...excluded].sort() } : {}) };
}
