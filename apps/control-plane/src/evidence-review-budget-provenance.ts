import { createHash } from "node:crypto";
import { validReviewerBudgetAdmission, type EvidenceReviewerBudgetAdmission } from "./evidence-review-admission.js";
import { videoReviewBindingDigest, type VideoReviewBinding, type VideoReviewVerdict } from "./video-evidence-runtime.js";

/** Structural #2936 completedAttestation adapter until legitimate budget-main integration.
 * Only the durable campaign ledger supplies this receipt; request JSON and native code-review
 * jobs are not sources. This does not grant new access, launch, spend or evidence approval. */
export interface CompletedMediaBudgetAttestation {
  rootSessionId: string;
  sessionId: string;
  checkpoint: { generation: string; historyEpoch: number; throughSeq: number; costUsd: number };
  actual: { costUsd: number; toolCalls: number };
  settlementDigest: string;
}
export interface MediaBudgetProvenancePorts {
  preflight(rootSessionId: string, sessionId: string): EvidenceReviewerBudgetAdmission | null;
  completedAttestation(sessionId: string): CompletedMediaBudgetAttestation | null;
  /** Server-owned immutable quality verdict for this exact original source and occurrence. */
  verdict(binding: VideoReviewBinding): VideoReviewVerdict | null;
  /** Current actual Session, including generation; never copied from the stored verdict. */
  worker(sessionId: string): {
    rootSessionId: string; driver: string; model: string | null; effort: string | null;
    generation: string; normalCompletion: boolean;
  } | null;
  /** Current owner action denials, root admission/exhaustion/accounting, scope and boundary.
   * Normal worker completion alone cannot waive any current constraint. */
  currentOwnerActionAllowed(binding: VideoReviewBinding): boolean;
}
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function exactSettlement(receipt: CompletedMediaBudgetAttestation | null, admission: EvidenceReviewerBudgetAdmission): boolean {
  if (!receipt || !receipt.checkpoint || !receipt.actual || receipt.rootSessionId !== admission.rootSessionId || receipt.sessionId !== admission.worker.sessionId ||
    receipt.checkpoint.generation !== admission.dispatch.generation ||
    !Number.isSafeInteger(receipt.checkpoint.historyEpoch) || receipt.checkpoint.historyEpoch < 0 ||
    !Number.isSafeInteger(receipt.checkpoint.throughSeq) || receipt.checkpoint.throughSeq < 0 ||
    !Number.isFinite(receipt.checkpoint.costUsd) || receipt.checkpoint.costUsd < 0 ||
    !Number.isFinite(receipt.actual.costUsd) || receipt.actual.costUsd < receipt.checkpoint.costUsd ||
    !Number.isSafeInteger(receipt.actual.toolCalls) || receipt.actual.toolCalls < 0 ||
    (admission.allocation.costUsd !== undefined && receipt.actual.costUsd > admission.allocation.costUsd + 1e-9) ||
    (admission.allocation.toolCalls !== undefined && receipt.actual.toolCalls > admission.allocation.toolCalls)) return false;
  return receipt.settlementDigest === sha({ rootSessionId: receipt.rootSessionId, sessionId: receipt.sessionId,
    checkpoint: receipt.checkpoint, actual: receipt.actual });
}

/** Active preflight stays separate from historical quality provenance. A completed worker's
 * final generation and immutable verdict may support its owner's original exact gate while
 * that worker loses all fresh media/verdict/dispatch access. */
export class EvidenceReviewBudgetProvenance {
  constructor(private readonly ports: MediaBudgetProvenancePorts) {}
  active(binding: VideoReviewBinding): EvidenceReviewerBudgetAdmission | null {
    const admission = this.ports.preflight(binding.rootSessionId, binding.reviewerSessionId);
    return validReviewerBudgetAdmission(admission, binding) ? admission : null;
  }
  private pinned(binding: VideoReviewBinding): EvidenceReviewerBudgetAdmission | null {
    const verdict = this.ports.verdict(binding);
    if (!verdict || verdict.bindingSha256 !== videoReviewBindingDigest(binding) ||
      verdict.reviewerSessionId !== binding.reviewerSessionId ||
      !validReviewerBudgetAdmission(verdict.workerAdmission, binding)) return null;
    return verdict.workerAdmission;
  }
  private completed(binding: VideoReviewBinding, admission: EvidenceReviewerBudgetAdmission): boolean {
    const worker = this.ports.worker(binding.reviewerSessionId);
    return Boolean(worker && worker.normalCompletion && worker.rootSessionId === binding.rootSessionId &&
      worker.driver === admission.worker.driver && worker.model === admission.worker.model &&
      worker.effort === admission.worker.effort && worker.generation === admission.dispatch.generation &&
      exactSettlement(this.ports.completedAttestation(binding.reviewerSessionId), admission));
  }
  historical(binding: VideoReviewBinding): EvidenceReviewerBudgetAdmission | null {
    if (!this.ports.currentOwnerActionAllowed(binding)) return null;
    const admission = this.pinned(binding);
    if (!admission) return null;
    const active = this.active(binding);
    if (active && sha(active) === sha(admission)) return structuredClone(admission);
    return this.completed(binding, admission) ? structuredClone(admission) : null;
  }
  normalCompletion(binding: VideoReviewBinding): boolean {
    const admission = this.pinned(binding);
    return Boolean(admission && this.completed(binding, admission));
  }
}
