import { validReviewerBudgetAdmission, type EvidenceReviewerBudgetAdmission } from "./evidence-review-admission.js";
import { createHash } from "node:crypto";
import { campaignEvidenceAuthorityBound, validCampaignEvidenceAuthority,
  type CampaignAuthorityBoundary, type CampaignEvidenceAuthority } from "@wollipog/protocol";
import { PACED_VIDEO_REVIEW_PROFILE, PRODUCTION_VIDEO_REVIEW_PROTOCOL } from "./video-evidence-runtime.js";

/** Stored by a human/operator validation ingress after independently inspected live evidence.
 * Deterministic fixture results, worker messages and client assertions cannot create this proof. */
export interface VideoProfileLiveProof {
  proofId: string;
  driver: string;
  modelId: string;
  providerId: string;
  capabilitiesSha256: string;
  reviewerNamespaceSha256: string;
  oracleIsolationEvidenceSha256: string;
  profile: typeof PACED_VIDEO_REVIEW_PROFILE;
  validatedAt: number;
  expiresAt: number;
  candidateValidationRunId: string;
  pacedValidationRunId: string;
  maximumProfileValidationRunId: string;
  sourceSha256: string;
  manifestSha256: string;
  orderedReceiptSetSha256: string;
  privateOracleCommitmentSha256: string;
  blindTemporalVerdictSha256: string;
  modelDeliveryEvidenceSha256: string;
  usageEvidenceSha256: string;
  pricingEvidenceSha256: string;
  inputTokens: number;
  outputTokens: number;
  actualCostUsd: number;
  latencyMs: number;
  verifiedByUserId: string;
}

export interface EvidenceReviewerTarget {
  agentId: string;
  driver: string;
  modelId: string;
  providerId: string;
  runnerId: string;
  runnerProtocolVersion: number;
  /** Digest of exact installed model/tool-result attestation, not prompt-image support. */
  capabilitiesSha256: string;
  auditedAllFrameDelivery: boolean;
  /** Current runner-verified narrowed media-only namespace, not a read-only write sandbox. */
  reviewerNamespaceSha256: string;
  mediaOnlyNamespaceVerified: boolean;
}
export interface ReviewerAdmissionContext {
  mode: "custom" | "full_control";
  rootSessionId: string;
  childSessionId: string;
  repository: string;
  issue: number;
  issueScopeRevision: number;
  policyRevision: number;
  boundary: CampaignAuthorityBoundary | null;
  evidenceAuthority: CampaignEvidenceAuthority | null;
  uiEvidenceOwner: "human" | "orchestrator";
  taskEvidenceVerified: boolean;
  destinationConfigurationId: string;
  organizationId: string;
  audienceSha256: string;
  controllerProtocolVersion: number;
  childProtocolVersion: number;
  /** Server-verified exact-current human grants, private destination configuration and scope. */
  boundaryCurrent: boolean;
  scopeCurrent: boolean;
  destinationPrivateVerified: boolean;
}

export type ReviewerAdmissionResult =
  | { ok: true; admissionId: string; reviewerSessionId: string; reservationId: string;
      workerAdmission: EvidenceReviewerBudgetAdmission }
  | { ok: false; reason: "custom_fallback" | "human_required" | "boundary" | "destination" |
      "provider" | "scope" | "mixed_peer" | "capability" | "live_validation" |
      "reviewer_namespace" | "allowance_unsupported" | "allowance" | "launch_uncertain" | "launch_failed" };

export interface ReviewerReservation {
  reservationId: string;
  reviewerSessionId: string;
  rootSessionId: string;
  policyRevision: number;
  admissionId: string;
  status: "reserved" | "active";
}
export interface ReviewerAllowanceAdapter {
  /** #2936 implements aggregate durable reservation before dispatch, including replacements.
   * No external subprocess, missing meter, or caller-authored cost estimate is admissible. */
  reserve(request: { admissionId: string; rootSessionId: string; issue: number; policyRevision: number;
    target: EvidenceReviewerTarget }): ReviewerReservation | null;
  current(reservationId: string): ReviewerReservation | null;
  preflight(reviewerSessionId: string): EvidenceReviewerBudgetAdmission | null;
  releaseUnlaunched(reservationId: string): void;
}
export interface ManagedReviewerDispatcher {
  launch(request: { admissionId: string; rootSessionId: string; childSessionId: string;
    audienceSha256: string; target: EvidenceReviewerTarget; reservation: ReviewerReservation })
    : Promise<{ status: "launched"; reviewerSessionId: string } | { status: "not_launched" } | { status: "uncertain" }>;
  /** Reconcile a lost response using the durable admission/reservation identity; never relaunch. */
  find(admissionId: string): { reviewerSessionId: string; rootSessionId: string; reservationId: string;
    audienceSha256: string; target: EvidenceReviewerTarget; status: "running" | "idle" | "completed" | "failed" } | null;
}
export interface ReviewerAdmissionDependencies {
  allowance?: ReviewerAllowanceAdapter;
  dispatcher?: ManagedReviewerDispatcher;
  context(): ReviewerAdmissionContext | null;
  liveProof(target: EvidenceReviewerTarget): VideoProfileLiveProof | null;
  /** Durably record before any dispatch; false means an existing admission must be reconciled. */
  begin(admissionId: string, bindingSha256: string): "created" | "existing" | "mismatch";
  finish(admissionId: string, result: ReviewerAdmissionResult): void;
}

const digest = (v: unknown): boolean => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
export function validVideoLiveProof(proof: VideoProfileLiveProof | null,
  target: EvidenceReviewerTarget, now: number): boolean {
  return Boolean(proof && proof.profile === PACED_VIDEO_REVIEW_PROFILE && proof.driver === target.driver &&
    proof.modelId === target.modelId && proof.providerId === target.providerId &&
    proof.capabilitiesSha256 === target.capabilitiesSha256 && digest(proof.capabilitiesSha256) &&
    target.mediaOnlyNamespaceVerified && digest(target.reviewerNamespaceSha256) &&
    proof.reviewerNamespaceSha256 === target.reviewerNamespaceSha256 && digest(proof.oracleIsolationEvidenceSha256) &&
    Number.isSafeInteger(proof.validatedAt) && proof.validatedAt > 0 && proof.validatedAt <= now &&
    Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > now &&
    proof.verifiedByUserId && proof.proofId && proof.candidateValidationRunId && proof.pacedValidationRunId &&
    proof.maximumProfileValidationRunId &&
    [proof.sourceSha256, proof.manifestSha256, proof.orderedReceiptSetSha256, proof.privateOracleCommitmentSha256,
      proof.blindTemporalVerdictSha256, proof.modelDeliveryEvidenceSha256, proof.usageEvidenceSha256,
      proof.pricingEvidenceSha256].every(digest) &&
    Number.isSafeInteger(proof.inputTokens) && proof.inputTokens > 0 &&
    Number.isSafeInteger(proof.outputTokens) && proof.outputTokens > 0 &&
    Number.isFinite(proof.actualCostUsd) && proof.actualCostUsd > 0 &&
    Number.isSafeInteger(proof.latencyMs) && proof.latencyMs > 0);
}

export function reviewerAdmissionReadiness(context: ReviewerAdmissionContext | null,
  target: EvidenceReviewerTarget, proof: VideoProfileLiveProof | null, now: number): ReviewerAdmissionResult | null {
  const refuse = (reason: Extract<ReviewerAdmissionResult, { ok: false }>["reason"]) => ({ ok: false as const, reason });
  if (!context) return refuse("boundary");
  if (context.mode === "custom") return refuse("custom_fallback");
  if (context.uiEvidenceOwner !== "orchestrator") return refuse("human_required");
  const b = context.boundary;
  const e = context.evidenceAuthority;
  if (!b || !e || !context.boundaryCurrent || !validCampaignEvidenceAuthority(e) ||
    !campaignEvidenceAuthorityBound(e, b) || e.campaignRootSessionId !== context.rootSessionId ||
    b.revision !== context.policyRevision || !b.operations.includes("ui_evidence_approval")) return refuse("boundary");
  if (!context.scopeCurrent || !context.taskEvidenceVerified || context.issueScopeRevision !== b.issueScopeRevision ||
    context.repository.toLowerCase() !== b.repository.toLowerCase() || !Number.isSafeInteger(context.issue) || context.issue <= 0) return refuse("scope");
  if (!context.destinationPrivateVerified || context.destinationConfigurationId !== e.destination.configurationId ||
    context.organizationId !== e.destination.organizationId) return refuse("destination");
  if (!e.providers.some((p) => p.providerId === target.providerId && p.reviewers.some((r) =>
    r.driver === target.driver && r.modelId === target.modelId))) return refuse("provider");
  if ([context.controllerProtocolVersion, context.childProtocolVersion, target.runnerProtocolVersion]
    .some((version) => !Number.isSafeInteger(version) || version < PRODUCTION_VIDEO_REVIEW_PROTOCOL)) return refuse("mixed_peer");
  if (!target.auditedAllFrameDelivery || !digest(target.capabilitiesSha256) || !digest(context.audienceSha256)) return refuse("capability");
  if (!target.mediaOnlyNamespaceVerified || !digest(target.reviewerNamespaceSha256)) return refuse("reviewer_namespace");
  if (!validVideoLiveProof(proof, target, now)) return refuse("live_validation");
  return null;
}

function currentWorkerAdmission(deps: ReviewerAdmissionDependencies, context: ReviewerAdmissionContext,
  target: EvidenceReviewerTarget, reviewerSessionId: string): EvidenceReviewerBudgetAdmission | null {
  const snapshot = deps.allowance?.preflight(reviewerSessionId) ?? null;
  return snapshot && validReviewerBudgetAdmission(snapshot, {
    rootSessionId: context.rootSessionId, reviewerSessionId, reviewerDriver: target.driver,
    reviewerModelId: target.modelId, boundaryRevision: context.policyRevision,
    workerAdmissionSha256: snapshot.allocationDigest,
  }) ? snapshot : null;
}

/** Request identity is persisted before dispatch. Allowance is reserved before launch. Unknown
 * launch outcomes retain their reservation and reconcile by identity; they never replay launch. */
export async function admitEvidenceReviewer(admissionId: string, target: EvidenceReviewerTarget,
  deps: ReviewerAdmissionDependencies, now = Date.now()): Promise<ReviewerAdmissionResult> {
  const fail = (reason: Extract<ReviewerAdmissionResult, { ok: false }>["reason"]): ReviewerAdmissionResult => ({ ok: false, reason });
  let context = deps.context();
  const refused = reviewerAdmissionReadiness(context, target, deps.liveProof(target), now);
  if (refused) return refused;
  if (!deps.allowance || !deps.dispatcher) return fail("allowance_unsupported");
  context = context!;
  if (!admissionId || admissionId.length > 256 || /[\x00-\x1f\x7f]/u.test(admissionId)) return fail("boundary");
  const bindingSha256 = createHash("sha256").update(JSON.stringify({ context, target })).digest("hex");
  const admission = deps.begin(admissionId, bindingSha256);
  if (admission === "mismatch") return fail("boundary");
  if (admission === "existing") {
    const found = deps.dispatcher.find(admissionId);
    const reservation = found && deps.allowance.current(found.reservationId);
    if (!found || !reservation || found.reviewerSessionId === context.childSessionId ||
      found.reviewerSessionId === context.rootSessionId || found.rootSessionId !== context.rootSessionId ||
      reservation.admissionId !== admissionId || reservation.rootSessionId !== context.rootSessionId ||
      reservation.policyRevision !== context.policyRevision || found.audienceSha256 !== context.audienceSha256 ||
      JSON.stringify(found.target) !== JSON.stringify(target) || !["running", "idle"].includes(found.status)) return fail("launch_uncertain");
    const workerAdmission = currentWorkerAdmission(deps, context, target, found.reviewerSessionId);
    if (!workerAdmission || found.reviewerSessionId !== reservation.reviewerSessionId) return fail("allowance");
    const result: ReviewerAdmissionResult = { ok: true, admissionId, reviewerSessionId: found.reviewerSessionId, reservationId: found.reservationId, workerAdmission };
    deps.finish(admissionId, result);
    return result;
  }
  const reservation = deps.allowance.reserve({ admissionId, rootSessionId: context.rootSessionId,
    issue: context.issue, policyRevision: context.policyRevision, target });
  if (!reservation || reservation.rootSessionId !== context.rootSessionId || reservation.admissionId !== admissionId ||
    reservation.policyRevision !== context.policyRevision || reservation.reviewerSessionId === context.childSessionId ||
    reservation.reviewerSessionId === context.rootSessionId ||
    !currentWorkerAdmission(deps, context, target, reservation.reviewerSessionId)) {
    const result = fail("allowance");
    deps.finish(admissionId, result);
    return result;
  }
  let outcome: Awaited<ReturnType<ManagedReviewerDispatcher["launch"]>>;
  try {
    const current = deps.context();
    const stale = reviewerAdmissionReadiness(current, target, deps.liveProof(target), now);
    if (stale || JSON.stringify(current) !== JSON.stringify(context)) {
      deps.allowance.releaseUnlaunched(reservation.reservationId);
      const result = stale ?? fail("boundary");
      deps.finish(admissionId, result);
      return result;
    }
    outcome = await deps.dispatcher.launch({ admissionId, rootSessionId: context.rootSessionId,
      childSessionId: context.childSessionId, audienceSha256: context.audienceSha256, target, reservation });
  } catch {
    // Lost response can still have launched a metered managed worker. Retain the reservation.
    outcome = { status: "uncertain" };
  }
  let result: ReviewerAdmissionResult;
  if (outcome.status === "not_launched") {
    deps.allowance.releaseUnlaunched(reservation.reservationId);
    result = fail("launch_failed");
  } else {
    const found = deps.dispatcher.find(admissionId);
    const current = deps.context();
    const stale = reviewerAdmissionReadiness(current, target, deps.liveProof(target), Date.now());
    const workerAdmission = found && currentWorkerAdmission(deps, context, target, found.reviewerSessionId);
    result = stale || JSON.stringify(current) !== JSON.stringify(context) ? stale ?? fail("boundary") : found && found.rootSessionId === context.rootSessionId && found.reservationId === reservation.reservationId &&
      found.reviewerSessionId !== context.childSessionId && found.reviewerSessionId !== context.rootSessionId &&
      found.audienceSha256 === context.audienceSha256 && JSON.stringify(found.target) === JSON.stringify(target) &&
      ["running", "idle"].includes(found.status) && workerAdmission &&
      found.reviewerSessionId === reservation.reviewerSessionId &&
      (outcome.status !== "launched" || found.reviewerSessionId === outcome.reviewerSessionId)
      ? { ok: true, admissionId, reviewerSessionId: found.reviewerSessionId, reservationId: reservation.reservationId, workerAdmission }
      : fail("launch_uncertain");
  }
  deps.finish(admissionId, result);
  return result;
}
