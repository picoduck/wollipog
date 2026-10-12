import { createHash } from "node:crypto";
import { campaignPublicationSafe, campaignPublicationTitle, type SessionView, type GithubIssueClosureSnapshot,
  type WorkflowDecisionResourceSnapshot, type CampaignWorkItemDetail } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { campaignBoundaryCurrent } from "./campaign-authority.js";

export const issueEvidenceDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

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
  const boundary = issueBoundary(root);
  if (!boundary?.issueAuthority?.relatedFollowUps || !boundary.operations.includes(snapshot.category) ||
      snapshot.repository !== boundary.repository.toLowerCase() || !snapshot.recommendationId ||
      !campaignPublicationSafe(snapshot.sanitizedTitle, snapshot.sanitizedBody, snapshot.labels)) return null;
  const recommendation = db.campaignWorkLedger.recommendation(root.id, snapshot.recommendationId);
  if (!recommendation || recommendation.disposition !== "accepted" || recommendation.duplicateOfId ||
      recommendation.publication !== "awaiting_publication" || !recommendation.dispositionReason ||
      recommendation.repository.toLowerCase() !== snapshot.repository ||
      campaignPublicationTitle(recommendation.title) !== campaignPublicationTitle(snapshot.sanitizedTitle) || !recommendation.originWorkItemIds.length) return null;
  const origins = recommendation.originWorkItemIds.map((id) => db.campaignWorkLedger.detail(root.id, id, Date.now())?.issue);
  if (origins.some((issue) => !issue || issue.repository.toLowerCase() !== snapshot.repository || !root.orchestratorPolicy?.issueNumbers?.includes(issue.number))) return null;
  // Scope capacity includes every outstanding publication reservation, so concurrent approvals
  // cannot consume the same final slot. This hook composes with aggregate campaign limits.
  const grants = db.campaignPublicationReservations(root.id);
  if (grants.some((d) => d.status === "consumed" && d.resourceSnapshot.category === snapshot.category && d.resourceSnapshot.recommendationId === snapshot.recommendationId)) return null;
  const reservations = reservedPublicationSlots(db, root, undefined, snapshot.recommendationId);
  if ((root.orchestratorPolicy?.issueNumbers?.length ?? 0) + reservations >= boundary.issueAuthority.maxIssues) return null;
  return { recommendation, origins, scopeRevision: boundary.issueScopeRevision, boundaryRevision: boundary.revision };
}

export function reservedPublicationSlots(db: ControlPlaneDb, root: SessionView, exceptOccurrence?: string, exceptRecommendation?: string): number {
  const recommendations = new Set<string>();
  for (const d of db.campaignPublicationReservations(root.id)) {
    if (d.occurrenceId === exceptOccurrence || d.resourceSnapshot.category !== "follow_up_issue_publication") continue;
    const id = d.resourceSnapshot.recommendationId;
    if (id && id === exceptRecommendation) continue;
    const published = id && db.campaignWorkLedger.recommendation(root.id, id)?.resultingIssue;
    if (!published || published.repository.toLowerCase() !== root.orchestratorPolicy?.issueScope?.repository.toLowerCase() ||
        !root.orchestratorPolicy?.issueNumbers?.includes(published.number)) recommendations.add(id ?? d.occurrenceId);
  }
  return recommendations.size;
}

/** Delivery is an independently verified report plus observed forge merges. Stage prose alone,
 * an enqueued PR, a stale observation, or a ledger insertion is never delivery evidence. */
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
  const merges = items.flatMap((item) => item.observed.pullRequests ?? []);
  if (!merges.length || merges.some((p) => {
    const fact = p.fact;
    return p.ref.repository.toLowerCase() !== snapshot.repository.toLowerCase() || fact.availability !== "fresh" ||
      fact.value.state !== "merged" || !fact.value.mergeCommitSha || !snapshot.delivery?.some((delivered) =>
        delivered.number === p.ref.number && delivered.headSha === fact.value.headSha && delivered.mergeCommitSha === fact.value.mergeCommitSha);
  })) return null;
  return { items: items.map((item) => ({ id: item.id, verifications: item.verifications })), delivery: snapshot.delivery };
}
