import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CreateSessionRequest, OperatorVideoValidationPurpose } from "@wollipog/protocol";
import type { AuthPrincipal } from "./identity.js";
import type { PreparedMediaSubject } from "./prepared-media-session-runtime.js";
import type { MaterializedMediaSession, PreparedMediaIdentity, PreparedMediaRecord } from "./prepared-media-sessions.js";
import { reviewerAdmissionPrerequisites, type EvidenceReviewerTarget, type ReviewerAdmissionContext } from "./evidence-review-worker.js";
import { MediaSessionPurposes } from "./media-session-purposes.js";
import type { VideoReviewBinding } from "./video-evidence-runtime.js";

export const OPERATOR_VIDEO_VALIDATION_PROFILES = Object.freeze({
  candidate: { frames: 16, width: 640, height: 360, durationUs: 4_000_000 },
  paced: { frames: 360, width: 1280, height: 720, durationUs: 12_000_000 },
  maximum: { frames: 900, width: 1280, height: 720, durationUs: 30_000_000 },
});
export type OperatorVideoValidationProfile = keyof typeof OPERATOR_VIDEO_VALIDATION_PROFILES;
export interface OperatorVideoValidationSubject extends PreparedMediaSubject { profile: OperatorVideoValidationProfile }
/** Returned ONLY by the installed server adapter after resolving the stored original Human gate,
 * actual source/full native derivation, private config/disclosure and narrowed installed profile.
 * current() must also check current user/org/session/daily/host/native/media concurrency and
 * hard action/accounting denials. Normal createSession admission repeats all creation guards.
 * A null adapter result fails closed. No worker, request body or fixture certifies these facts. */
export interface OperatorVideoValidationScope {
  identity: PreparedMediaIdentity;
  subject: OperatorVideoValidationSubject;
  authorizedByUserId: string;
  organizationId: string;
  gate: { authority: "human"; status: "pending"; resourceDigest: string; policyRevision: number };
  source: { artifactId: string; sha256: string; sizeBytes: number; manifestSha256: string;
    orderedFramesSha256: string; criteriaSha256: string; frames: number; width: number; height: number; durationUs: number };
  context: ReviewerAdmissionContext;
  target: EvidenceReviewerTarget;
  request: CreateSessionRequest;
  providerExecutableSha256: string;
  nativeToolProfileSha256: string;
  namespaceLaunchSha256: string;
  authoritySha256: string;
}
export interface OperatorVideoValidationPorts {
  current(identity: PreparedMediaIdentity, subject: OperatorVideoValidationSubject): OperatorVideoValidationScope | null;
}
export interface OperatorVideoValidationPermit {
  purpose: "operator_video_validation";
  permitId: string;
  scopeSha256: string;
  scope: OperatorVideoValidationScope;
  mintedByUserId: string;
  createdAt: number;
  expiresAt: number;
  state: "authorized" | "bound" | "revoked";
  actual: { sessionId: string; runnerId: string; generation: string; commandSha256: string;
    allocationDigest: string } | null;
}
export const operatorVideoValidationDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = operatorVideoValidationDigest;
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/u.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function validScope(scope: OperatorVideoValidationScope): boolean {
  if (!scope || !scope.identity || !scope.subject || !scope.source || !scope.gate || !scope.request ||
    !Object.hasOwn(OPERATOR_VIDEO_VALIDATION_PROFILES, scope.subject.profile)) return false;
  const { identity: i, subject: subject, source: s, context: c, target: t, request: r } = scope;
  const expected = OPERATOR_VIDEO_VALIDATION_PROFILES[subject.profile];
  return [i.rootSessionId, i.childSessionId, i.admissionId, subject.occurrenceId, subject.evidenceId,
    s.artifactId, scope.authorizedByUserId, scope.organizationId].every(id) &&
    i.rootSessionId !== i.childSessionId && c?.rootSessionId === i.rootSessionId && c.childSessionId === i.childSessionId &&
    scope.organizationId === c.organizationId && scope.authorizedByUserId === c.boundary?.authorizedByUserId &&
    scope.gate.authority === "human" && scope.gate.status === "pending" && scope.gate.policyRevision === c.policyRevision &&
    reviewerAdmissionPrerequisites(c, t, "human") === null &&
    [i.requestSha256, scope.gate.resourceDigest, s.sha256, s.manifestSha256, s.orderedFramesSha256, s.criteriaSha256,
      scope.providerExecutableSha256, scope.nativeToolProfileSha256, scope.namespaceLaunchSha256, scope.authoritySha256].every(digest) &&
    Number.isSafeInteger(s.sizeBytes) && s.sizeBytes > 0 && s.sizeBytes <= 32 * 1024 * 1024 &&
    s.frames === expected.frames && s.width === expected.width && s.height === expected.height && s.durationUs === expected.durationUs &&
    r.agentId === t.agentId && r.runnerId === t.runnerId && r.role !== "orchestrator" &&
    r.launchSurface !== "native_tui" && !r.images?.length && !r.workspacePath && r.config?.model === t.modelId &&
    positive(r.config?.costBudgetUsd) && Number.isSafeInteger(r.config?.maxToolCalls) && Number(r.config?.maxToolCalls) > 0;
}

/** Human-only, finite, one-shot CODE ingress for a separately reviewed isolated operator action.
 * Not registered in hosting, no API route, no production-proof exemption, no model call/upload.
 * The permit is a narrowing of existing grants/allowance; it cannot mint those grants itself.
 * An original occurrence/evidence/profile cannot acquire another permit after revocation/replay.
 * Materialization claim and permanent Session purpose must commit in the same SQLite transaction.
 */
export class OperatorVideoValidationPermits {
  private readonly purposes: MediaSessionPurposes;
  constructor(readonly database: DatabaseSync, private readonly ports: OperatorVideoValidationPorts,
    private readonly now: () => number = Date.now) {
    this.purposes = new MediaSessionPurposes(database);
    database.exec("CREATE TABLE IF NOT EXISTS operator_video_validation_permits (" +
      "permit_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, admission_id TEXT NOT NULL," +
      "occurrence_id TEXT NOT NULL,evidence_id TEXT NOT NULL,profile TEXT NOT NULL," +
      "record TEXT NOT NULL,sha256 TEXT NOT NULL,UNIQUE(root_id,admission_id)," +
      "UNIQUE(occurrence_id,evidence_id,profile));");
  }
  private write(permit: OperatorVideoValidationPermit, insert = false): void {
    const record = JSON.stringify(permit);
    if (Buffer.byteLength(record) > 64 * 1024) throw new Error("Validation permit metadata exceeds its bound.");
    if (insert) this.database.prepare("INSERT INTO operator_video_validation_permits VALUES (?,?,?,?,?,?,?,?)")
      .run(permit.permitId, permit.scope.identity.rootSessionId, permit.scope.identity.admissionId,
        permit.scope.subject.occurrenceId, permit.scope.subject.evidenceId, permit.scope.subject.profile, record, sha(permit));
    else this.database.prepare("UPDATE operator_video_validation_permits SET record=?,sha256=? WHERE permit_id=?")
      .run(record, sha(permit), permit.permitId);
  }
  get(permitId: string): OperatorVideoValidationPermit | null {
    const row = this.database.prepare("SELECT * FROM operator_video_validation_permits WHERE permit_id=?")
      .get(permitId) as { record: string; sha256: string; root_id: string; admission_id: string;
        occurrence_id: string; evidence_id: string; profile: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.record) as OperatorVideoValidationPermit;
    if (!p || p.purpose !== "operator_video_validation" || p.permitId !== permitId || sha(p) !== row.sha256 ||
      !validScope(p.scope) || p.scopeSha256 !== sha(p.scope) || p.mintedByUserId !== p.scope.authorizedByUserId ||
      p.scope.identity.rootSessionId !== row.root_id || p.scope.identity.admissionId !== row.admission_id ||
      p.scope.subject.occurrenceId !== row.occurrence_id || p.scope.subject.evidenceId !== row.evidence_id ||
      p.scope.subject.profile !== row.profile || !Number.isSafeInteger(p.createdAt) || !Number.isSafeInteger(p.expiresAt) ||
      p.expiresAt <= p.createdAt || p.expiresAt > p.createdAt + 60 * 60 * 1000 ||
      !["authorized", "bound", "revoked"].includes(p.state) ||
      (p.state === "authorized" && p.actual !== null) || (p.state === "bound" && !p.actual)) {
      throw new Error("Durable operator validation permit is invalid.");
    }
    return p;
  }
  mint(principal: AuthPrincipal, proposal: { identity: PreparedMediaIdentity;
    subject: OperatorVideoValidationSubject; expiresAt: number }): OperatorVideoValidationPermit | null {
    if (principal.kind !== "human" || !["owner", "admin"].includes(principal.role) || !proposal ||
      Object.keys(proposal).length !== 3 || !["identity", "subject", "expiresAt"].every((k) => Object.hasOwn(proposal, k))) return null;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(proposal.expiresAt) ||
      proposal.expiresAt <= now || proposal.expiresAt > now + 60 * 60 * 1000) return null;
    const scope = this.ports.current(proposal.identity, proposal.subject);
    if (!scope || !validScope(scope) || sha(scope.identity) !== sha(proposal.identity) || sha(scope.subject) !== sha(proposal.subject) ||
      scope.authorizedByUserId !== principal.userId || scope.organizationId !== principal.organizationId) return null;
    const permit: OperatorVideoValidationPermit = { purpose: "operator_video_validation",
      permitId: "video_validation_" + randomUUID().replaceAll("-", ""), scope: structuredClone(scope), scopeSha256: sha(scope),
      mintedByUserId: principal.userId, createdAt: now, expiresAt: proposal.expiresAt, state: "authorized", actual: null };
    // SQL uniqueness is the durable one-shot gate, including across independent instances.
    try { this.write(permit, true); } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return null;
      throw error;
    }
    return structuredClone(permit);
  }
  current(permitId: string): OperatorVideoValidationPermit | null {
    const permit = this.get(permitId);
    if (!permit || permit.state === "revoked" || permit.createdAt > this.now() || permit.expiresAt <= this.now()) return null;
    const actual = this.ports.current(permit.scope.identity, permit.scope.subject);
    return actual && validScope(actual) && sha(actual) === permit.scopeSha256 ? permit : null;
  }
  authorizePreparation(permitId: string, identity: PreparedMediaIdentity, subject: PreparedMediaSubject,
    context: ReviewerAdmissionContext, target: EvidenceReviewerTarget, request: CreateSessionRequest): boolean {
    const p = this.current(permitId);
    return Boolean(p && p.state === "authorized" && sha(p.scope.identity) === sha(identity) &&
      p.scope.subject.occurrenceId === subject.occurrenceId && p.scope.subject.evidenceId === subject.evidenceId &&
      sha(p.scope.context) === sha(context) && sha(p.scope.target) === sha(target) && sha(p.scope.request) === sha(request));
  }
  purpose(permitId: string): OperatorVideoValidationPurpose | null {
    const p = this.current(permitId);
    return p ? { permitId: p.permitId, scopeSha256: p.scopeSha256 } : null;
  }
  /** Server-owned binding for the distinct validation runtime access adapter. Its caller must
   * additionally require active managed admission for derive/media/verdict and genuine historical
   * settlement for Human inspection. This binding cannot enter production approvalProvenance. */
  binding(permitId: string): VideoReviewBinding | null {
    const p = this.current(permitId);
    if (!p || p.state !== "bound" || !p.actual || !this.purposes.credentialCurrent(p.actual.sessionId)) return null;
    const purpose = this.purposes.get(p.actual.sessionId);
    if (!purpose || purpose.operatorValidation?.permitId !== p.permitId || purpose.operatorValidation.scopeSha256 !== p.scopeSha256 ||
      purpose.generation !== p.actual.generation || sha(purpose.command) !== p.actual.commandSha256) return null;
    const s = p.scope;
    return { operatorValidation: { permitId: p.permitId, scopeSha256: p.scopeSha256 },
      rootSessionId: s.identity.rootSessionId, childSessionId: s.identity.childSessionId, occurrenceId: s.subject.occurrenceId,
      resourceDigest: s.gate.resourceDigest, policyRevision: s.gate.policyRevision, boundaryRevision: s.context.boundary!.revision,
      evidenceAuthorityRevision: s.context.evidenceAuthority!.revision, reviewerSessionId: p.actual.sessionId,
      reviewerDriver: s.target.driver, reviewerModelId: s.target.modelId, providerId: s.target.providerId,
      audienceSha256: s.context.audienceSha256, capabilitiesSha256: s.target.capabilitiesSha256,
      sourceEvidenceId: s.subject.evidenceId, sourceArtifactId: s.source.artifactId, sourceSha256: s.source.sha256,
      workerAdmissionSha256: p.actual.allocationDigest, criteriaSha256: s.source.criteriaSha256 };
  }
  bindPrepared(permitId: string, materialized: MaterializedMediaSession): void {
    const p = this.current(permitId);
    if (!this.database.isTransaction || !p || p.state !== "authorized") throw new Error("One current atomic validation admission is required.");
    const a = materialized.admission, config = materialized.command.spec.config;
    const r = p.scope.request, t = p.scope.target;
    if (materialized.sessionId === p.scope.identity.rootSessionId || materialized.sessionId === p.scope.identity.childSessionId ||
      materialized.command.type !== "start_session" || materialized.command.spec.sessionId !== materialized.sessionId ||
      materialized.runnerId !== t.runnerId || materialized.command.spec.driver !== t.driver ||
      a.rootSessionId !== p.scope.identity.rootSessionId || a.worker.sessionId !== materialized.sessionId ||
      a.worker.driver !== t.driver || a.worker.model !== t.modelId || a.worker.effort !== (r.config?.effort ?? null) ||
      config?.model !== t.modelId || (config?.effort ?? null) !== a.worker.effort ||
      !positive(config?.costBudgetUsd) || config.costBudgetUsd > r.config!.costBudgetUsd! ||
      !Number.isSafeInteger(config?.maxToolCalls) || Number(config?.maxToolCalls) <= 0 || config!.maxToolCalls! > r.config!.maxToolCalls! ||
      !positive(a.allocation.costUsd) || a.allocation.costUsd > r.config!.costBudgetUsd! ||
      !Number.isSafeInteger(a.allocation.toolCalls) || Number(a.allocation.toolCalls) <= 0 || a.allocation.toolCalls! > r.config!.maxToolCalls! ||
      a.authorityRevision !== p.scope.gate.policyRevision || !digest(a.allocationDigest) || !id(a.dispatch.generation) ||
      sha(materialized.command.spec.campaignBudgetDispatch) !== sha(a.dispatch)) throw new Error("Actual validation Session/profile/allocation changed.");
    // Require the real Session/member/command purpose created by the ordinary guarded pipeline.
    const actual = this.database.prepare("SELECT 1 FROM sessions s JOIN campaign_budget_members m ON m.session_id=s.id " +
      "WHERE s.id=? AND s.parent_session_id=? AND s.runner_id=? AND m.root_id=? AND m.generation=?")
      .get(materialized.sessionId, p.scope.identity.rootSessionId, materialized.runnerId, a.rootSessionId, a.dispatch.generation);
    if (!actual) throw new Error("Real managed validation Session and current generation are required.");
    const purpose = this.purposes.get(materialized.sessionId);
    if (!purpose || purpose.operatorValidation?.permitId !== p.permitId || purpose.operatorValidation.scopeSha256 !== p.scopeSha256 ||
      purpose.rootSessionId !== p.scope.identity.rootSessionId || purpose.childSessionId !== p.scope.identity.childSessionId ||
      purpose.admissionId !== p.scope.identity.admissionId || purpose.occurrenceId !== p.scope.subject.occurrenceId ||
      purpose.evidenceId !== p.scope.subject.evidenceId || purpose.resourceDigest !== p.scope.gate.resourceDigest ||
      purpose.policyRevision !== p.scope.gate.policyRevision || purpose.generation !== a.dispatch.generation ||
      sha(purpose.command) !== sha(materialized.command)) throw new Error("Permanent original validation purpose is required.");
    p.actual = { sessionId: materialized.sessionId, runnerId: materialized.runnerId, generation: a.dispatch.generation,
      commandSha256: sha(materialized.command), allocationDigest: a.allocationDigest };
    p.state = "bound"; this.write(p);
  }
  /** Called by trusted PreparedMediaSessionPorts.authorize at bind/dispatch/reconcile; missing
   * real namespace/driver/sender integration remains unsupported. Current authority is re-read.
   * Coordinator owns the atomic one-shot dispatch; this permit never releases reservations. */
  authorize(record: PreparedMediaRecord): boolean {
    const ref = record.binding?.grant.operatorValidation;
    const p = ref ? this.current(ref.permitId) : null;
    if (!p || !p.actual || p.state !== "bound" || ref?.scopeSha256 !== p.scopeSha256 ||
      sha(p.scope.identity) !== sha({ rootSessionId: record.rootSessionId, childSessionId: record.childSessionId,
        admissionId: record.admissionId, requestSha256: record.requestSha256 }) ||
      p.actual.sessionId !== record.sessionId || p.actual.runnerId !== record.runnerId ||
      p.actual.generation !== record.admission.dispatch.generation || p.actual.commandSha256 !== sha(record.command) ||
      p.actual.allocationDigest !== record.admission.allocationDigest || !record.binding) return false;
    const { scope: s } = p, g = record.binding.grant;
    const binding = this.binding(p.permitId);
    const generation = this.database.prepare("SELECT 1 FROM campaign_budget_members WHERE session_id=? AND root_id=? AND generation=?")
      .get(record.sessionId, record.rootSessionId, p.actual.generation);
    const purpose = this.purposes.get(record.sessionId);
    return Boolean(generation && binding && g.bindingSha256 === sha(binding) && purpose?.operatorValidation?.permitId === p.permitId &&
      purpose.operatorValidation.scopeSha256 === p.scopeSha256 && purpose.generation === p.actual.generation &&
      sha(purpose.command) === p.actual.commandSha256 && record.binding.namespaceLaunchSha256 === s.namespaceLaunchSha256 &&
      record.binding.namespacePolicySha256 === s.target.reviewerNamespaceSha256 && record.binding.authoritySha256 === s.authoritySha256 &&
      g.occurrenceId === s.subject.occurrenceId && g.sourceEvidenceId === s.subject.evidenceId &&
      g.sourceArtifactId === s.source.artifactId && g.sourceSha256 === s.source.sha256 &&
      g.manifestSha256 === s.source.manifestSha256 && g.criteriaSha256 === s.source.criteriaSha256 &&
      sha(g.frames) === s.source.orderedFramesSha256 &&
      g.reviewerSessionId === record.sessionId && g.childSessionId === record.childSessionId &&
      g.policyRevision === s.gate.policyRevision && g.expiresAt <= p.expiresAt && g.expiresAt > this.now() &&
      g.frames.length === s.source.frames && g.frames.every((f, i) => f.index === i && digest(f.sha256) &&
        Number.isSafeInteger(f.ptsUs) && f.ptsUs === (i === 0 ? 0 : g.frames[i - 1]!.ptsUs + g.frames[i - 1]!.durationUs) &&
        Number.isSafeInteger(f.durationUs) && f.durationUs >= 33_000) &&
      g.frames.at(-1)!.ptsUs + g.frames.at(-1)!.durationUs === s.source.durationUs);
  }
  revoke(principal: AuthPrincipal, permitId: string): boolean {
    const p = this.get(permitId);
    if (!p || p.state === "revoked" || principal.kind !== "human" || !["owner", "admin"].includes(principal.role) ||
      principal.userId !== p.mintedByUserId || principal.organizationId !== p.scope.organizationId) return false;
    p.state = "revoked"; this.write(p); return true;
  }
}
