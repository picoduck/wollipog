import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ReviewerAdmissionResult } from "./evidence-review-worker.js";
import { validReviewerBudgetAdmission } from "./evidence-review-admission.js";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const failureReasons = ["custom_fallback", "human_required", "boundary", "destination", "provider", "scope",
  "mixed_peer", "capability", "live_validation", "reviewer_namespace", "allowance_unsupported",
  "allowance", "launch_uncertain", "launch_failed"];

/** Durable dispatch intent, not a budget ledger, Session identity or evidence grant. Every
 * reconciliation still uses the actual managed Session and current campaign budget preflight. */
export class SqliteEvidenceReviewerAdmissions {
  constructor(private readonly db: DatabaseSync, private readonly rootSessionId: string) {
    if (!id(rootSessionId)) throw new Error("A concrete campaign root is required.");
    db.exec("CREATE TABLE IF NOT EXISTS evidence_reviewer_admissions (" +
      "root_id TEXT NOT NULL,admission_id TEXT NOT NULL,binding_sha256 TEXT NOT NULL," +
      "result TEXT,result_sha256 TEXT,PRIMARY KEY(root_id,admission_id));");
  }
  begin(admissionId: string, bindingSha256: string): "created" | "existing" | "mismatch" {
    if (!id(admissionId) || !digest(bindingSha256)) return "mismatch";
    const inserted = this.db.prepare("INSERT OR IGNORE INTO evidence_reviewer_admissions(root_id,admission_id,binding_sha256) VALUES (?,?,?)")
      .run(this.rootSessionId, admissionId, bindingSha256);
    if (Number(inserted.changes) === 1) return "created";
    const row = this.db.prepare("SELECT binding_sha256 FROM evidence_reviewer_admissions WHERE root_id=? AND admission_id=?")
      .get(this.rootSessionId, admissionId) as { binding_sha256: string } | undefined;
    return row?.binding_sha256 === bindingSha256 ? "existing" : "mismatch";
  }
  get(admissionId: string): { bindingSha256: string; result: ReviewerAdmissionResult | null } | null {
    const row = this.db.prepare("SELECT binding_sha256,result,result_sha256 FROM evidence_reviewer_admissions WHERE root_id=? AND admission_id=?")
      .get(this.rootSessionId, admissionId) as { binding_sha256: string; result: string | null; result_sha256: string | null } | undefined;
    if (!row) return null;
    return { bindingSha256: row.binding_sha256,
      result: row.result && sha(row.result) === row.result_sha256 ? JSON.parse(row.result) as ReviewerAdmissionResult : null };
  }
  finish(admissionId: string, result: ReviewerAdmissionResult): void {
    const record = this.get(admissionId);
    if (!record || !result || typeof result !== "object" || Array.isArray(result)) throw new Error("Unknown reviewer dispatch intent.");
    if (result.ok) {
      const admission = result.workerAdmission;
      if (result.admissionId !== admissionId || !id(result.reviewerSessionId) || !id(result.reservationId) ||
        !admission || typeof admission.worker?.model !== "string" || !admission.worker.model ||
        !validReviewerBudgetAdmission(admission, { rootSessionId: this.rootSessionId,
          reviewerSessionId: result.reviewerSessionId, reviewerDriver: admission.worker.driver,
          reviewerModelId: admission.worker.model, boundaryRevision: admission.authorityRevision,
          workerAdmissionSha256: admission.allocationDigest })) throw new Error("Reviewer result is not bound to this actual campaign admission.");
    } else if (!failureReasons.includes(result.reason)) throw new Error("Unknown reviewer admission outcome.");
    const encoded = JSON.stringify(result);
    if (encoded.length > 16_000) throw new Error("Reviewer admission result exceeds its metadata bound.");
    if (record.result && (record.result.ok || record.result.reason !== "launch_uncertain") &&
      JSON.stringify(record.result) !== encoded) throw new Error("A settled reviewer intent cannot be rebound or replayed.");
    this.db.prepare("UPDATE evidence_reviewer_admissions SET result=?,result_sha256=? WHERE root_id=? AND admission_id=?")
      .run(encoded, sha(encoded), this.rootSessionId, admissionId);
  }
}
