import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EvidenceRecoveryPlan } from "./evidence-review-recovery.js";
import type { PreparedVideoFrame } from "./video-evidence-preparation.js";

export interface RecoverySubject {
  rootSessionId: string; childSessionId: string; occurrenceId: string; evidenceId: string;
  resourceDigest: string; policyRevision: number; sourceSha256: string;
  criteriaSha256: string; workerAdmissionSha256: string;
}
export interface RecoveryReplacement {
  /** New immutable artifacts/occurrences; the original gate is never rewritten. */
  subjects: Array<{ occurrenceId: string; evidenceId: string; artifactId: string; sha256: string }>;
  frames: Array<PreparedVideoFrame & { originalIndex: number; originalPtsUs: number }>;
}
export interface RecoveryExecutionPorts {
  /** Current original authority, source, privacy, capture capability, action and finite allowance.
   * Null means no execution permission. Facts must come from trusted stored records, not JSON. */
  current(subject: RecoverySubject): readonly PreparedVideoFrame[] | null;
  execute(subject: RecoverySubject, action: "split" | "recapture", operationId: string,
    reason: string): Promise<RecoveryReplacement["subjects"] | null>;
  /** Lost response: read the same durable capture operation, never submit another capture. */
  reconcile(operationId: string): Promise<RecoveryReplacement["subjects"] | null>;
  /** Independently reads actual immutable replacement artifacts and derives complete native
   * coverage. Capture output/worker messages cannot supply their own pixels or coverage proof. */
  verifyReplacement(subjects: RecoveryReplacement["subjects"]): Promise<RecoveryReplacement | null>;
}
export type RecoveryExecutionResult = { state: "completed"; replacement: RecoveryReplacement } |
  { state: "unsupported" | "exhausted" | "uncertain" | "rejected" };
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/u.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);

/** Durable bounded capture coordinator. It never launches generic commands, uploads, changes
 * original snapshots, resets spending, or guesses whether an ambiguous capture ran. */
export class EvidenceRecoveryExecutor {
  constructor(private readonly db: DatabaseSync, private readonly ports: RecoveryExecutionPorts) {
    db.exec("CREATE TABLE IF NOT EXISTS evidence_recovery_execution (subject_sha256 TEXT NOT NULL," +
      "attempt INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE, source_frames_sha256 TEXT NOT NULL," +
      "state TEXT NOT NULL, result TEXT, PRIMARY KEY(subject_sha256,attempt));");
  }
  private frames(subject: RecoverySubject): readonly PreparedVideoFrame[] | null {
    if (!subject || Object.keys(subject).length !== 9 || Object.keys(subject).some((key) =>
      !["rootSessionId", "childSessionId", "occurrenceId", "evidenceId", "resourceDigest", "policyRevision",
        "sourceSha256", "criteriaSha256", "workerAdmissionSha256"].includes(key)) ||
      ![subject.rootSessionId, subject.childSessionId, subject.occurrenceId, subject.evidenceId].every(id) ||
      ![subject.sourceSha256, subject.resourceDigest, subject.criteriaSha256, subject.workerAdmissionSha256].every(digest) ||
      !Number.isSafeInteger(subject.policyRevision) || subject.policyRevision <= 0) return null;
    const frames = this.ports.current(subject);
    return frames && frames.length > 0 && frames.length <= 900 && frames.every((f, i) =>
      f.index === i && digest(f.sha256) && Number.isSafeInteger(f.ptsUs) && f.ptsUs >= 0 &&
      Number.isSafeInteger(f.durationUs) && f.durationUs > 0 && Number.isSafeInteger(f.sizeBytes) && f.sizeBytes > 0 &&
      (i === 0 || f.ptsUs === frames[i - 1]!.ptsUs + frames[i - 1]!.durationUs)) ? structuredClone(frames) : null;
  }
  private complete(original: readonly PreparedVideoFrame[], value: RecoveryReplacement | null): value is RecoveryReplacement {
    return Boolean(value && Array.isArray(value.subjects) && value.subjects.length > 0 && value.subjects.length <= 8 &&
      value.subjects.every((s) => s && Object.keys(s).length === 4 && Object.keys(s).every((key) =>
        ["occurrenceId", "evidenceId", "artifactId", "sha256"].includes(key)) &&
        [s.occurrenceId, s.evidenceId, s.artifactId].every(id) && digest(s.sha256)) &&
      new Set(value.subjects.map((s) => s.artifactId)).size === value.subjects.length &&
      Array.isArray(value.frames) && value.frames.length === original.length && value.frames.every((f, i) =>
        f.originalIndex === i && f.originalPtsUs === original[i]!.ptsUs && f.durationUs === original[i]!.durationUs &&
        f.sha256 === original[i]!.sha256 && f.sizeBytes === original[i]!.sizeBytes));
  }
  async execute(subject: RecoverySubject, plan: EvidenceRecoveryPlan): Promise<RecoveryExecutionResult> {
    if (plan.action !== "split" && plan.action !== "recapture") return { state: "unsupported" };
    if (!Number.isSafeInteger(plan.nextAttempt) || plan.nextAttempt < 1 || plan.nextAttempt > 2) return { state: "exhausted" };
    const frames = this.frames(subject);
    if (!frames) return { state: "unsupported" };
    const key = sha(subject), frameDigest = sha(frames), attempt = plan.nextAttempt;
    const operationId = "media_recovery_" + sha({ key, attempt, action: plan.action });
    if (this.db.prepare("SELECT 1 FROM evidence_recovery_execution WHERE subject_sha256=? AND attempt<? AND state='uncertain'")
      .get(key, attempt)) return { state: "uncertain" };
    const inserted = this.db.prepare("INSERT OR IGNORE INTO evidence_recovery_execution VALUES (?,?,?,?,'uncertain',NULL)")
      .run(key, attempt, operationId, frameDigest);
    const row = this.db.prepare("SELECT * FROM evidence_recovery_execution WHERE subject_sha256=? AND attempt=?")
      .get(key, attempt) as { operation_id: string; source_frames_sha256: string; state: string; result: string | null };
    if (row.operation_id !== operationId || row.source_frames_sha256 !== frameDigest) return { state: "rejected" };
    if (row.state === "rejected") return { state: "rejected" };
    if (row.state === "completed") {
      const saved = row.result ? JSON.parse(row.result) as RecoveryReplacement : null;
      if (!this.complete(frames, saved)) return { state: "rejected" };
      let replacement: RecoveryReplacement | null;
      try { replacement = await this.ports.verifyReplacement(saved.subjects); } catch { return { state: "uncertain" }; }
      const current = this.frames(subject);
      return current && sha(current) === frameDigest && this.complete(frames, replacement) && sha(replacement) === sha(saved)
        ? { state: "completed", replacement } : { state: "rejected" };
    }
    let replacement: RecoveryReplacement | null;
    try {
      const subjects = Number(inserted.changes) === 1
        ? await this.ports.execute(structuredClone(subject), plan.action, operationId, plan.reason)
        : await this.ports.reconcile(operationId);
      replacement = subjects ? await this.ports.verifyReplacement(subjects) : null;
    } catch { return { state: "uncertain" }; }
    if (!replacement) return { state: "uncertain" };
    const current = this.frames(subject);
    if (!current || sha(current) !== frameDigest || !this.complete(frames, replacement) ||
      replacement.subjects.some((s) => s.occurrenceId === subject.occurrenceId || s.evidenceId === subject.evidenceId)) {
      this.db.prepare("UPDATE evidence_recovery_execution SET state='rejected' WHERE operation_id=?").run(operationId);
      return { state: "rejected" };
    }
    const encoded = JSON.stringify(replacement);
    if (Buffer.byteLength(encoded) > 512 * 1024) return { state: "rejected" };
    this.db.prepare("UPDATE evidence_recovery_execution SET state='completed',result=? WHERE operation_id=?")
      .run(encoded, operationId);
    return { state: "completed", replacement };
  }
}
