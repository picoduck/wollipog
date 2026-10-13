import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EvidenceRecoveryPlan } from "./evidence-review-recovery.js";
import type { PreparedVideoFrame } from "./video-evidence-preparation.js";

export interface RecoverySubject {
  rootSessionId: string; childSessionId: string; occurrenceId: string; evidenceId: string;
  resourceDigest: string; policyRevision: number; sourceSha256: string;
  criteriaSha256: string; workerAdmissionSha256: string;
}
/** Immutable original ancestry/aggregate ceilings from trusted storage, never new request IDs. */
export interface RecoveryLineage {
  rootSessionId: string; originalOccurrenceId: string; originalEvidenceId: string;
  sourceSha256: string; criteriaSha256: string; captureTraceSha256: string;
  transientCoverageSha256: string; actionSha256: string;
  maxCostUsd: number; maxToolCalls: number; maxWorkUnits: number;
}
export interface RecoveryAuthority {
  subject: RecoverySubject; lineage: RecoveryLineage; frames: readonly PreparedVideoFrame[];
  disposition: { kind: "recoverable_inadequate_evidence" | "permission_denied" | "human_required" | "unknown";
    ownerId: string; actualOwnerId: string; ownerKind: "orchestrator" | "human"; occurrenceId: string; resourceDigest: string;
    policyRevision: number; receiptSha256: string; expiresAt: number };
  /** Independent current reservation within original aggregate ceilings, never evidence approval. */
  capture: { allowanceId: string; independent: boolean; actionSha256: string; profileSha256: string;
    expiresAt: number; maxCostUsd: number; maxToolCalls: number; sourceSizeBytes: number;
    maxWorkUnits: number; lineageBudgetCurrent: boolean };
  freshGate: { ownerId: string; authoritySha256: string; boundarySha256: string;
    scopeSha256: string; audienceSha256: string; criteriaSha256: string; expiresAt: number };
  current: { rootActive: boolean; admission: boolean; scope: boolean; privacy: boolean;
    denied: boolean; humanRequired: boolean; ownerRevoked: boolean };
}
export interface RecoveryArtifact { artifactId: string; sha256: string; sizeBytes: number }
export interface RecoveryCapture {
  artifacts: RecoveryArtifact[];
  frames: Array<PreparedVideoFrame & { segmentIndex: number; originalIndex: number; originalPtsUs: number }>;
  captureTraceSha256: string; transientCoverageSha256: string; actionSha256: string;
}
export interface RecoveryReplacement extends RecoveryCapture {
  subjects: Array<{ occurrenceId: string; evidenceId: string; artifactId: string; sha256: string;
    resourceDigest: string; criteriaSha256: string; profileSha256: string; ownerId: string;
    authoritySha256: string }>;
}
export type RecoveryStage = "reject_original" | "capture" | "create_occurrences";
export interface RecoveryIntent {
  operationId: string; attempt: number; action: "split" | "recapture";
  subject: RecoverySubject; authoritySha256: string;
}
export interface RecoveryStageReceipt {
  operationId: string; stage: RecoveryStage; intentSha256: string; outcome: "completed" | "refused";
  rejectionSha256?: string; artifacts?: RecoveryArtifact[]; subjects?: RecoveryReplacement["subjects"];
}
export interface RecoveryExecutionPorts {
  /** Authenticate immutable ancestry, ACTUAL owner's explicit recoverable-quality disposition,
   * current independent aggregate capture reservation and fresh gate authority. Generic denial,
   * Human Required and missing distinctions return null; no synthetic owner/principal exists. */
  current(subject: RecoverySubject): RecoveryAuthority | null;
  /** Atomically enforce exact durable idempotency and current authority at the actual mutation.
   * Reject original only through its current typed owner. Never replace permission denial with
   * quality rejection. Preserve original aggregate spending/unknown charges across every ID. */
  executeStage(stage: RecoveryStage, intent: RecoveryIntent, operationId: string,
    prior: readonly RecoveryStageReceipt[]): Promise<RecoveryStageReceipt | null>;
  /** Read SAME durable original outcome; never resubmit capture, denial or new-gate mutation. */
  reconcileStage(stage: RecoveryStage, intent: RecoveryIntent, operationId: string): Promise<RecoveryStageReceipt | null>;
  /** Independent authenticated durable lookup, never mutation-worker self-report. */
  verifyStage(receipt: RecoveryStageReceipt, intent: RecoveryIntent): Promise<boolean>;
  /** Derive all native frames and independently verify original timing/action/transient trace
   * from actual immutable artifacts and trusted capture records. Unknown trace refuses. */
  verifyArtifacts(artifacts: readonly RecoveryArtifact[], intent: RecoveryIntent): Promise<RecoveryCapture | null>;
  /** Read actual fresh exact occurrences/criteria/source/profile/owner authority and lineage. */
  verifyOccurrences(subjects: RecoveryReplacement["subjects"], intent: RecoveryIntent): Promise<boolean>;
}
export type RecoveryExecutionResult = { state: "completed"; replacement: RecoveryReplacement } |
  { state: "unsupported" | "exhausted" | "uncertain" | "rejected" };
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/u.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const SUBJECT_KEYS = ["rootSessionId", "childSessionId", "occurrenceId", "evidenceId", "resourceDigest",
  "policyRevision", "sourceSha256", "criteriaSha256", "workerAdmissionSha256"];
const STAGES: readonly RecoveryStage[] = ["reject_original", "capture", "create_occurrences"];
const TOTAL_FRAME_BYTES = 128 * 1024 * 1024, SOURCE_BYTES = 32 * 1024 * 1024;
type AttemptRow = { operation_id: string; intent: string; state: string; result: string | null };

/** UNREGISTERED preparation only. No generic command, capture/provider/upload, Human owner,
 * live allowance, oracle or production certificate is supplied by this coordinator. */
export class EvidenceRecoveryExecutor {
  private readonly active = new Set<string>();
  constructor(private readonly db: DatabaseSync, private readonly ports: RecoveryExecutionPorts) {
    db.exec("CREATE TABLE IF NOT EXISTS evidence_recovery_lineages (lineage_key TEXT PRIMARY KEY,lineage_sha256 TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS evidence_recovery_attempts (lineage_key TEXT NOT NULL, attempt INTEGER NOT NULL," +
      "operation_id TEXT NOT NULL UNIQUE,intent TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(lineage_key,attempt));" +
      "CREATE TABLE IF NOT EXISTS evidence_recovery_stages (operation_id TEXT NOT NULL,stage TEXT NOT NULL," +
      "state TEXT NOT NULL,receipt TEXT,PRIMARY KEY(operation_id,stage));");
  }
  private authority(subject: RecoverySubject): RecoveryAuthority | null {
    if (!subject || Object.keys(subject).length !== SUBJECT_KEYS.length || Object.keys(subject).some((k) => !SUBJECT_KEYS.includes(k)) ||
      ![subject.rootSessionId, subject.childSessionId, subject.occurrenceId, subject.evidenceId].every(id) ||
      ![subject.resourceDigest, subject.sourceSha256, subject.criteriaSha256, subject.workerAdmissionSha256].every(digest) ||
      !positive(subject.policyRevision)) return null;
    const a = this.ports.current(subject);
    if (!a || sha(a.subject) !== sha(subject)) return null;
    const l = a.lineage, d = a.disposition, c = a.capture, g = a.freshGate, now = Date.now();
    if (!l || l.rootSessionId !== subject.rootSessionId || ![l.originalOccurrenceId, l.originalEvidenceId].every(id) ||
      ![l.sourceSha256, l.criteriaSha256, l.captureTraceSha256, l.transientCoverageSha256, l.actionSha256].every(digest) ||
      !Number.isFinite(l.maxCostUsd) || l.maxCostUsd <= 0 || !positive(l.maxToolCalls) || !positive(l.maxWorkUnits) ||
      (subject.occurrenceId === l.originalOccurrenceId && (subject.evidenceId !== l.originalEvidenceId ||
        subject.sourceSha256 !== l.sourceSha256 || subject.criteriaSha256 !== l.criteriaSha256)) ||
      !d || d.kind !== "recoverable_inadequate_evidence" || d.ownerKind !== "orchestrator" || !id(d.ownerId) || d.ownerId !== d.actualOwnerId ||
      d.occurrenceId !== subject.occurrenceId || d.resourceDigest !== subject.resourceDigest || d.policyRevision !== subject.policyRevision ||
      !digest(d.receiptSha256) || !positive(d.expiresAt) || d.expiresAt <= now ||
      !c || c.independent !== true || c.lineageBudgetCurrent !== true || !id(c.allowanceId) || c.actionSha256 !== l.actionSha256 ||
      !digest(c.profileSha256) || !positive(c.expiresAt) || c.expiresAt <= now ||
      !Number.isFinite(c.maxCostUsd) || c.maxCostUsd <= 0 || c.maxCostUsd > l.maxCostUsd ||
      !positive(c.maxToolCalls) || c.maxToolCalls > l.maxToolCalls || !positive(c.maxWorkUnits) || c.maxWorkUnits > l.maxWorkUnits ||
      !positive(c.sourceSizeBytes) || c.sourceSizeBytes > SOURCE_BYTES ||
      !g || g.ownerId !== d.actualOwnerId || ![g.authoritySha256, g.boundarySha256, g.scopeSha256, g.audienceSha256, g.criteriaSha256].every(digest) ||
      !positive(g.expiresAt) || g.expiresAt <= now || !a.current ||
      [a.current.rootActive, a.current.admission, a.current.scope, a.current.privacy].some((v) => v !== true) ||
      [a.current.denied, a.current.humanRequired, a.current.ownerRevoked].some((v) => v !== false)) return null;
    const frames = a.frames;
    if (!Array.isArray(frames) || frames.length === 0 || frames.length > 8 * 900 || frames.length > c.maxWorkUnits ||
      !frames.every((f, i) => f.index === i && digest(f.sha256) && Number.isSafeInteger(f.ptsUs) &&
        f.ptsUs === (i === 0 ? 0 : frames[i - 1]!.ptsUs + frames[i - 1]!.durationUs) && positive(f.durationUs) && positive(f.sizeBytes)) ||
      frames.reduce((sum, f) => sum + f.sizeBytes, 0) > TOTAL_FRAME_BYTES ||
      frames.at(-1)!.ptsUs + frames.at(-1)!.durationUs > 8 * 30_000_000) return null;
    return structuredClone(a);
  }
  private captureValid(a: RecoveryAuthority, value: RecoveryCapture | null, action: "split" | "recapture"): value is RecoveryCapture {
    if (!value || value.captureTraceSha256 !== a.lineage.captureTraceSha256 ||
      value.transientCoverageSha256 !== a.lineage.transientCoverageSha256 || value.actionSha256 !== a.lineage.actionSha256 ||
      !Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > 8 ||
      !value.artifacts.every((s) => s && Object.keys(s).length === 3 && id(s.artifactId) && digest(s.sha256) &&
        positive(s.sizeBytes) && s.sizeBytes <= SOURCE_BYTES) ||
      value.artifacts.reduce((sum, f) => sum + f.sizeBytes, 0) > SOURCE_BYTES ||
      new Set(value.artifacts.map((s) => s.artifactId)).size !== value.artifacts.length ||
      !Array.isArray(value.frames) || value.frames.length !== a.frames.length ||
      value.frames.reduce((sum, f) => sum + f.sizeBytes, 0) > TOTAL_FRAME_BYTES) return false;
    let segment = -1, localIndex = 0, localPts = 0;
    for (let i = 0; i < value.frames.length; i++) {
      const f = value.frames[i]!, original = a.frames[i]!;
      if (f.segmentIndex !== segment) {
        if (f.segmentIndex !== segment + 1) return false;
        segment++; localIndex = 0; localPts = 0;
      }
      if (segment >= value.artifacts.length || f.index !== localIndex++ || f.ptsUs !== localPts || localIndex > 900 ||
        f.originalIndex !== i || f.originalPtsUs !== original.ptsUs || f.durationUs !== original.durationUs ||
        !digest(f.sha256) || !positive(f.sizeBytes) || f.sizeBytes > 2 * 1024 * 1024 ||
        (action === "split" && (f.sha256 !== original.sha256 || f.sizeBytes !== original.sizeBytes))) return false;
      localPts += f.durationUs;
      if (localPts > 30_000_000) return false;
    }
    return segment === value.artifacts.length - 1;
  }
  private subjectsValid(a: RecoveryAuthority, capture: RecoveryCapture, subjects: RecoveryReplacement["subjects"]): boolean {
    return Array.isArray(subjects) && subjects.length === capture.artifacts.length && subjects.every((s, i) =>
      s && Object.keys(s).length === 9 && [s.occurrenceId, s.evidenceId, s.artifactId].every(id) &&
      s.occurrenceId !== a.subject.occurrenceId && s.occurrenceId !== a.lineage.originalOccurrenceId &&
      s.evidenceId !== a.subject.evidenceId && s.evidenceId !== a.lineage.originalEvidenceId &&
      s.artifactId === capture.artifacts[i]!.artifactId && s.sha256 === capture.artifacts[i]!.sha256 &&
      digest(s.resourceDigest) && s.resourceDigest !== a.subject.resourceDigest && s.criteriaSha256 === a.freshGate.criteriaSha256 &&
      s.profileSha256 === a.capture.profileSha256 && s.ownerId === a.freshGate.ownerId && s.authoritySha256 === a.freshGate.authoritySha256) &&
      new Set(subjects.map((s) => s.occurrenceId)).size === subjects.length && new Set(subjects.map((s) => s.evidenceId)).size === subjects.length;
  }
  private stillCurrent(a: RecoveryAuthority): boolean {
    const current = this.authority(a.subject);
    return current !== null && sha(current) === sha(a);
  }
  private reject(operationId: string): RecoveryExecutionResult {
    this.db.prepare("UPDATE evidence_recovery_attempts SET state='rejected' WHERE operation_id=?").run(operationId);
    return { state: "rejected" };
  }
  private uncertain(operationId: string): RecoveryExecutionResult {
    // Retain any historical result. A now-unverifiable completed outcome must also block a
    // fresh attempt until this SAME operation is independently reconciled again.
    this.db.prepare("UPDATE evidence_recovery_attempts SET state='uncertain' WHERE operation_id=?").run(operationId);
    return { state: "uncertain" };
  }
  async execute(subject: RecoverySubject, plan: EvidenceRecoveryPlan): Promise<RecoveryExecutionResult> {
    if (plan.action !== "split" && plan.action !== "recapture") return { state: "unsupported" };
    if (!positive(plan.nextAttempt) || plan.nextAttempt > 2) return { state: "exhausted" };
    let a: RecoveryAuthority | null;
    try { a = this.authority(subject); } catch { return { state: "unsupported" }; }
    if (!a || this.db.isTransaction) return { state: "unsupported" };
    const lineageKey = sha({ root: a.lineage.rootSessionId, original: a.lineage.originalOccurrenceId }), attempt = plan.nextAttempt;
    const operationId = "media_recovery_" + sha({ lineageKey, attempt });
    const intent: RecoveryIntent = { operationId, attempt, action: plan.action, subject: structuredClone(subject), authoritySha256: sha(a) };
    // Prior preparation rows lack stable authenticated ancestry/phase outcomes. Unknown/possibly
    // charged old work cannot migrate into a fresh allowance, even under different request IDs.
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evidence_recovery_execution'").get() &&
      this.db.prepare("SELECT 1 FROM evidence_recovery_execution LIMIT 1").get()) return { state: "uncertain" };
    this.db.exec("BEGIN IMMEDIATE");
    let row: AttemptRow;
    try {
      this.db.prepare("INSERT OR IGNORE INTO evidence_recovery_lineages VALUES (?,?)").run(lineageKey, sha(a.lineage));
      const lineage = this.db.prepare("SELECT lineage_sha256 FROM evidence_recovery_lineages WHERE lineage_key=?").get(lineageKey);
      if (lineage?.lineage_sha256 !== sha(a.lineage)) { this.db.exec("ROLLBACK"); return { state: "rejected" }; }
      const prior = this.db.prepare("SELECT attempt,state FROM evidence_recovery_attempts WHERE lineage_key=? ORDER BY attempt").all(lineageKey);
      if (prior.some((r) => r.state === "uncertain" && Number(r.attempt) !== attempt)) { this.db.exec("ROLLBACK"); return { state: "uncertain" }; }
      const existing = prior.some((r) => Number(r.attempt) === attempt);
      if (!existing && (prior.length >= 2 || attempt !== prior.length + 1)) { this.db.exec("ROLLBACK"); return { state: "exhausted" }; }
      this.db.prepare("INSERT OR IGNORE INTO evidence_recovery_attempts VALUES (?,?,?,?,'uncertain',NULL)")
        .run(lineageKey, attempt, operationId, JSON.stringify(intent));
      row = this.db.prepare("SELECT * FROM evidence_recovery_attempts WHERE lineage_key=? AND attempt=?").get(lineageKey, attempt) as AttemptRow;
      this.db.exec("COMMIT");
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
    // Changed current authority cannot authorize readback or replay of an old mutation. Its
    // unknown outcome remains unknown, rather than implying a durable rejection or safe retry.
    if (row.intent !== JSON.stringify(intent) || row.operation_id !== operationId) {
      // An authority renewal gives no permission to reverify or replay completed work. Keep
      // completed history distinct from a true rejection and from a different subject/attempt.
      if (row.state === "completed") {
        try {
          const saved = JSON.parse(row.intent) as RecoveryIntent;
          if (saved.operationId === operationId && saved.attempt === attempt && saved.action === intent.action &&
            JSON.stringify(saved.subject) === JSON.stringify(intent.subject)) return { state: "unsupported" };
        } catch { return { state: "unsupported" }; }
      }
      return { state: row.state === "uncertain" ? "uncertain" : "rejected" };
    }
    if (row.state === "rejected") return { state: "rejected" };
    if (this.active.has(operationId)) return { state: "uncertain" };
    this.active.add(operationId);
    try {
      const receipts: RecoveryStageReceipt[] = []; let capture: RecoveryCapture | null = null;
      for (const stage of STAGES) {
        if (!this.stillCurrent(a)) return { state: "unsupported" };
        // Commit exact stage intent BEFORE mutation. Lost response uses readback exclusively.
        const inserted = this.db.prepare("INSERT OR IGNORE INTO evidence_recovery_stages VALUES (?,?,'uncertain',NULL)").run(operationId, stage);
        const stageRow = this.db.prepare("SELECT state,receipt FROM evidence_recovery_stages WHERE operation_id=? AND stage=?")
          .get(operationId, stage) as { state: string; receipt: string | null };
        if (stageRow.state === "refused") return this.reject(operationId);
        const stageId = operationId + ":" + stage;
        const receipt = stageRow.state === "completed" && stageRow.receipt ? JSON.parse(stageRow.receipt) as RecoveryStageReceipt
          : Number(inserted.changes) === 1 ? await this.ports.executeStage(stage, intent, stageId, structuredClone(receipts))
            : await this.ports.reconcileStage(stage, intent, stageId);
        if (!receipt) return this.uncertain(operationId);
        const allowed = ["operationId", "stage", "intentSha256", "outcome", ...(receipt.outcome === "refused" ? []
          : stage === "reject_original" ? ["rejectionSha256"] : stage === "capture" ? ["artifacts"] : ["subjects"])];
        if (Object.keys(receipt).length !== allowed.length || Object.keys(receipt).some((key) => !allowed.includes(key)) ||
          Buffer.byteLength(JSON.stringify(receipt)) > 32 * 1024) return this.uncertain(operationId);
        if (receipt.operationId !== stageId || receipt.stage !== stage || receipt.intentSha256 !== sha(intent) ||
          !["completed", "refused"].includes(receipt.outcome) || !(await this.ports.verifyStage(receipt, intent))) return this.uncertain(operationId);
        if (!this.stillCurrent(a)) return { state: "unsupported" };
        if (receipt.outcome === "refused") {
          this.db.prepare("UPDATE evidence_recovery_stages SET state='refused' WHERE operation_id=? AND stage=?").run(operationId, stage);
          return this.reject(operationId);
        }
        if (stage === "reject_original" && !digest(receipt.rejectionSha256)) return this.uncertain(operationId);
        if (stage === "capture") {
          if (!receipt.artifacts || JSON.stringify(receipt.artifacts).length > 16 * 1024) return this.uncertain(operationId);
          capture = await this.ports.verifyArtifacts(receipt.artifacts, intent);
          if (!capture) return this.uncertain(operationId);
          if (!this.captureValid(a, capture, intent.action) || sha(capture.artifacts) !== sha(receipt.artifacts)) return this.reject(operationId);
        }
        if (stage === "create_occurrences" && (!capture || !receipt.subjects || !this.subjectsValid(a, capture, receipt.subjects) ||
          !(await this.ports.verifyOccurrences(receipt.subjects, intent)))) return this.uncertain(operationId);
        if (!this.stillCurrent(a)) return { state: "unsupported" };
        const encoded = JSON.stringify(receipt);
        if (Buffer.byteLength(encoded) > 32 * 1024) return this.uncertain(operationId);
        this.db.prepare("UPDATE evidence_recovery_stages SET state='completed',receipt=? WHERE operation_id=? AND stage=?").run(encoded, operationId, stage);
        receipts.push(receipt);
      }
      if (!capture || !this.stillCurrent(a)) return { state: "unsupported" };
      const replacement: RecoveryReplacement = { ...capture, subjects: receipts.at(-1)!.subjects! }, encoded = JSON.stringify(replacement);
      if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) return this.reject(operationId);
      if (row.result !== null && row.result !== encoded) return this.reject(operationId);
      this.db.prepare("UPDATE evidence_recovery_attempts SET state='completed',result=? WHERE operation_id=?").run(encoded, operationId);
      return { state: "completed", replacement };
    } catch { return this.uncertain(operationId); }
    finally { this.active.delete(operationId); }
  }
}
