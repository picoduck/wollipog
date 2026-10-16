import { createHash } from "node:crypto";

/** Structural adapter to #2936 campaignBudgetWorkerPreflight. Only the service supplies this
 * snapshot from the current managed ledger; an agent body is never an admission source. */
export interface EvidenceReviewerBudgetAdmission {
  rootSessionId: string;
  authorityRevision: number;
  allocationDigest: string;
  allocation: { sessionId: string; costUsd?: number; toolCalls?: number };
  dispatch: { rootSessionId: string; generation: string };
  worker: { sessionId: string; driver: string; model: string | null; effort: string | null };
}
export function reviewerBudgetAdmissionDigest(snapshot: Omit<EvidenceReviewerBudgetAdmission, "allocationDigest">): string {
  return createHash("sha256").update(JSON.stringify({
    rootSessionId: snapshot.rootSessionId, authorityRevision: snapshot.authorityRevision,
    allocation: snapshot.allocation, dispatch: snapshot.dispatch, worker: snapshot.worker,
  })).digest("hex");
}
export function validReviewerBudgetAdmission(snapshot: EvidenceReviewerBudgetAdmission | null,
  expected: { rootSessionId: string; reviewerSessionId: string; reviewerDriver: string;
    reviewerModelId: string; boundaryRevision: number; workerAdmissionSha256: string }): snapshot is EvidenceReviewerBudgetAdmission {
  if (!snapshot || snapshot.rootSessionId !== expected.rootSessionId ||
    snapshot.authorityRevision !== expected.boundaryRevision ||
    !snapshot.dispatch || snapshot.dispatch.rootSessionId !== expected.rootSessionId ||
    typeof snapshot.dispatch.generation !== "string" || !snapshot.dispatch.generation ||
    snapshot.dispatch.generation.length > 256 || /[\x00-\x1f\x7f]/u.test(snapshot.dispatch.generation) ||
    snapshot.worker.sessionId !== expected.reviewerSessionId || snapshot.allocation.sessionId !== expected.reviewerSessionId ||
    snapshot.worker.driver !== expected.reviewerDriver || snapshot.worker.model !== expected.reviewerModelId ||
    snapshot.allocationDigest !== expected.workerAdmissionSha256 ||
    !/^[a-f0-9]{64}$/u.test(snapshot.allocationDigest) ||
    snapshot.allocationDigest !== reviewerBudgetAdmissionDigest(snapshot)) return false;
  return (snapshot.allocation.costUsd === undefined || Number.isFinite(snapshot.allocation.costUsd) && snapshot.allocation.costUsd > 0) &&
    (snapshot.allocation.toolCalls === undefined || Number.isSafeInteger(snapshot.allocation.toolCalls) && snapshot.allocation.toolCalls > 0);
}
