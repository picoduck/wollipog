import { createHash, randomUUID } from "node:crypto";
import type { ResolveWorkflowDecisionRequest, SessionView, WorkflowDecisionView,
  WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { VideoEvidenceDecisionBridge, type VideoEvidenceGateAccess } from "./video-evidence-decision-bridge.js";
import type { VideoEvidenceRuntime } from "./video-evidence-runtime.js";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type ImageReceipt = { receipt_id: string; evidence_id: string; artifact_id: string; sha256: string;
  child_session_id: string; policy_revision: number; acknowledged_at: number | null;
  consumed_at: number | null; revoked_at: number | null; expires_at: number };
type Approval = { occurrenceId: string; rootSessionId: string; childSessionId: string;
  resourceDigest: string; policyRevision: number; evidenceReviewed: string[];
  delegatedVideoEvidence: NonNullable<WorkflowDecisionView["delegatedVideoEvidence"]>;
  imageReceiptIds: string[]; resolvedAt: number };
export interface WorkflowVideoEvidenceAccess extends Omit<VideoEvidenceGateAccess, "directImageReviewed"> {
  /** Trusted server readiness: current human envelope/private disclosure, actual scoped worker
   * capability/namespace, empirical live proof and protected root budget readiness. Never agent JSON.
   * The actual worker is reserved after the original occurrence exists; dispatch/media/verdict
   * still require its exact admitted Session. Completed proof is historical, never fresh access.
   * This probe authorizes no media read, dispatch, spend or gate resolution. */
  available(controller: SessionView, child: SessionView, snapshot: WorkflowDecisionResourceSnapshot): boolean;
}

/** Composes the existing gate with exact actual-worker proof. Persisted references and direct
 * image receipt IDs commit with approval; nothing is attributed to the controlling actor that
 * its authenticated image transport did not deliver. No runtime registration is supplied here. */
export class WorkflowVideoEvidenceApprovals {
  private readonly bridge: VideoEvidenceDecisionBridge;
  constructor(readonly database: ControlPlaneDb, runtime: VideoEvidenceRuntime,
    private readonly access: WorkflowVideoEvidenceAccess, private readonly clock = Date.now) {
    database.raw().exec("CREATE TABLE IF NOT EXISTS workflow_video_approvals (" +
      "occurrence_id TEXT PRIMARY KEY REFERENCES workflow_decisions(occurrence_id), record TEXT NOT NULL, sha256 TEXT NOT NULL)");
    this.bridge = new VideoEvidenceDecisionBridge(runtime, {
      decisionCurrent: (decision, phase) => access.decisionCurrent(decision, phase),
      linkedReview: (decision, evidenceId) => access.linkedReview(decision, evidenceId),
      directImageReviewed: (decision, evidenceId) => this.directImageReviewed(decision, evidenceId) });
  }
  available(controller: SessionView, child: SessionView, snapshot: WorkflowDecisionResourceSnapshot): boolean {
    try { return this.access.available(controller, child, snapshot); } catch { return false; }
  }
  private approval(decision: WorkflowDecisionView): Approval {
    const row = this.database.raw().prepare("SELECT record,sha256 FROM workflow_video_approvals WHERE occurrence_id=?")
      .get(decision.occurrenceId) as { record: string; sha256: string } | undefined;
    if (!row || digest(row.record) !== row.sha256) throw new Error("Original media approval provenance is absent or corrupt.");
    const saved = JSON.parse(row.record) as Approval;
    if (saved.occurrenceId !== decision.occurrenceId || saved.rootSessionId !== decision.controllingSessionId ||
      saved.childSessionId !== decision.sessionId || saved.resourceDigest !== decision.resourceDigest ||
      saved.policyRevision !== decision.policyRevision || saved.resolvedAt !== decision.resolvedAt ||
      JSON.stringify(saved.evidenceReviewed) !== JSON.stringify(decision.evidenceReviewed) ||
      JSON.stringify(saved.delegatedVideoEvidence) !== JSON.stringify(decision.delegatedVideoEvidence)) {
      throw new Error("Original media approval changed after resolution.");
    }
    return saved;
  }
  private receipt(decision: WorkflowDecisionView, evidenceId: string): ImageReceipt | null {
    const row = this.database.raw().prepare("SELECT * FROM ui_evidence_review_receipts WHERE occurrence_id=? " +
      "AND reviewer_session_id=? AND evidence_id=?").get(decision.occurrenceId, decision.controllingSessionId, evidenceId) as ImageReceipt | undefined;
    if (!row || row.acknowledged_at == null || row.revoked_at != null || row.expires_at <= this.clock() ||
      row.child_session_id !== decision.sessionId || row.policy_revision !== decision.policyRevision) return null;
    if (decision.status === "pending") return row.consumed_at == null ? row : null;
    if (decision.status !== "approved" || row.consumed_at !== decision.resolvedAt ||
      !this.approval(decision).imageReceiptIds.includes(row.receipt_id)) return null;
    return row;
  }
  private directImageReviewed(decision: WorkflowDecisionView, evidenceId: string): boolean {
    if (decision.resourceSnapshot.category !== "ui_evidence_approval") return false;
    const item = decision.resourceSnapshot.evidence.find((candidate) => candidate.evidenceId === evidenceId);
    const receipt = this.receipt(decision, evidenceId);
    if (!item?.mediaType?.startsWith("image/") || !item.artifactId || !receipt ||
      receipt.artifact_id !== item.artifactId || receipt.sha256 !== item.sha256) return false;
    const source = this.database.workflowArtifactExportPreflight(item.artifactId)?.artifact;
    const controllerScope = this.database.sessionScope(decision.controllingSessionId);
    const childScope = this.database.sessionScope(decision.sessionId);
    if (!controllerScope || !childScope ||
      !this.database.scopeAudienceContainedWithMembership(controllerScope, childScope) ||
      !source || source.sessionId !== decision.sessionId || source.kind !== "screenshot" ||
      source.mimeType !== item.mediaType || source.sha256 !== item.sha256) return false;
    const bytes = this.database.readWorkflowArtifactBytes(item.artifactId);
    return Boolean(bytes && digest(bytes) === item.sha256);
  }
  private atomic<T>(operation: () => T): T {
    const sql = this.database.raw(), savepoint = "media_gate_" + randomUUID().replaceAll("-", "");
    sql.exec("SAVEPOINT " + savepoint);
    try { const value = operation(); sql.exec("RELEASE " + savepoint); return value; }
    catch (error) { sql.exec("ROLLBACK TO " + savepoint); sql.exec("RELEASE " + savepoint); throw error; }
  }
  resolve(decision: WorkflowDecisionView, resolution: ResolveWorkflowDecisionRequest, now: number,
    mutation: () => WorkflowDecisionView | null): WorkflowDecisionView {
    return this.atomic(() => {
      const images = resolution.evidenceReviewed ?? [], delegated = resolution.delegatedVideoEvidence ?? [];
      this.bridge.approvalProvenance(decision, images, delegated, "resolve");
      const saved: Approval = { occurrenceId: decision.occurrenceId, rootSessionId: decision.controllingSessionId,
        childSessionId: decision.sessionId, resourceDigest: decision.resourceDigest, policyRevision: decision.policyRevision,
        evidenceReviewed: images, delegatedVideoEvidence: delegated,
        imageReceiptIds: images.map((id) => this.receipt(decision, id)!.receipt_id), resolvedAt: now };
      const resolved = mutation();
      if (!resolved || resolved.status !== "approved" || resolved.resolvedAt !== now ||
        JSON.stringify(resolved.delegatedVideoEvidence) !== JSON.stringify(delegated) ||
        JSON.stringify(resolved.evidenceReviewed) !== JSON.stringify(images)) throw new Error("Original UI gate changed before approval committed.");
      const record = JSON.stringify(saved);
      this.database.raw().prepare("INSERT INTO workflow_video_approvals VALUES (?,?,?)")
        .run(decision.occurrenceId, record, digest(record));
      this.database.consumeUiEvidenceReviewReceipts(decision.occurrenceId, now);
      return resolved;
    });
  }
  consume(decision: WorkflowDecisionView, mutation: () => WorkflowDecisionView | null): WorkflowDecisionView {
    return this.atomic(() => {
      const saved = this.approval(decision);
      this.bridge.approvalProvenance(decision, saved.evidenceReviewed, saved.delegatedVideoEvidence, "consume");
      const consumed = mutation();
      if (!consumed || consumed.status !== "consumed") throw new Error("Original UI gate changed before consumption.");
      return consumed;
    });
  }
}
