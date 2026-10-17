import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AuthPrincipal } from "./identity.js";
import { PACED_VIDEO_REVIEW_PROFILE } from "./video-evidence-runtime.js";
import { validVideoLiveProof, type EvidenceReviewerTarget, type VideoProfileLiveProof } from "./evidence-review-worker.js";

export interface InspectedVideoValidationRun {
  runId: string;
  kind: "candidate" | "paced" | "maximum";
  target: EvidenceReviewerTarget;
  sourceSha256: string;
  manifestSha256: string;
  orderedReceiptSetSha256: string;
  privateOracleCommitmentSha256: string;
  blindTemporalVerdictSha256: string;
  modelDeliveryEvidenceSha256: string;
  usageEvidenceSha256: string;
  pricingEvidenceSha256: string;
  oracleIsolationEvidenceSha256: string;
  frameCount: number;
  width: number;
  height: number;
  durationUs: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  actualCostUsd: number;
  latencyMs: number;
  /** These facts must come from inspected private evidence and server records, never test booleans
   * or a reviewer's normal message. The authenticated human ingress owns that adjudication. */
  allSourceFramesDelivered: boolean;
  blindOracleMatched: boolean;
  privateOracleExcludedFromReviewerContext: boolean;
  /** Actual narrowed tool/filesystem namespace probes, not directory separation or a prompt. */
  oracleNamespaceInaccessibleVerified: boolean;
  providerUsageVerified: boolean;
  currentOfficialPricingVerified: boolean;
  sourceAndArtifactsStillMatch: boolean;
  inspectedByUserId: string;
}

/** Owner/admin inventory row. Evidence digests and run bodies stay in the stored proof. */
export interface VideoLiveValidationSummary {
  proofId: string;
  driver: string;
  modelId: string;
  providerId: string;
  capabilitiesSha256: string;
  validatedAt: number;
  expiresAt: number;
  verifiedByUserId: string;
  revoked: boolean;
  expired: boolean;
}
const administrator = (principal: AuthPrincipal) => principal.kind === "human" && ["owner", "admin"].includes(principal.role);

/** Separate explicit operator/human approval of actual empirical proof; production settings
 * cannot create it. It is invalidated when the harness/model/capability contract changes. */
export class VideoLiveValidationRegistry {
  constructor(private readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS video_profile_live_validation (" +
      "proof_id TEXT PRIMARY KEY, driver TEXT NOT NULL, model_id TEXT NOT NULL, provider_id TEXT NOT NULL," +
      "capabilities_sha256 TEXT NOT NULL, proof TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);");
  }

  recordInspectedRuns(principal: AuthPrincipal, target: EvidenceReviewerTarget,
    runs: readonly InspectedVideoValidationRun[], now = Date.now()): VideoProfileLiveProof | null {
    if (principal.kind !== "human" || !administrator(principal) || !Array.isArray(runs as unknown) || runs.length !== 3 || new Set(runs.map((r) => r.kind)).size !== 3 ||
      new Set(runs.map((r) => r.runId)).size !== 3 || !Number.isSafeInteger(now) || now <= 0) return null;
    const digest = (value: string) => /^[a-f0-9]{64}$/u.test(value);
    const expected = {
      candidate: { frames: 16, width: 640, height: 360, durationUs: 4_000_000 },
      paced: { frames: 360, width: 1280, height: 720, durationUs: 12_000_000 },
      maximum: { frames: 900, width: 1280, height: 720, durationUs: 30_000_000 },
    };
    for (const run of runs) {
      const profile = expected[run.kind];
      if (!profile || !run.runId || run.runId.length > 256 ||
        JSON.stringify(run.target) !== JSON.stringify(target) || run.inspectedByUserId !== principal.userId ||
        !run.allSourceFramesDelivered || !run.blindOracleMatched || !run.privateOracleExcludedFromReviewerContext ||
        !run.oracleNamespaceInaccessibleVerified || !target.mediaOnlyNamespaceVerified ||
        !digest(target.reviewerNamespaceSha256) || !run.providerUsageVerified || !run.currentOfficialPricingVerified || !run.sourceAndArtifactsStillMatch ||
        run.frameCount !== profile.frames || run.width !== profile.width || run.height !== profile.height ||
        run.durationUs !== profile.durationUs ||
        ![run.sourceSha256, run.manifestSha256, run.orderedReceiptSetSha256, run.privateOracleCommitmentSha256,
          run.blindTemporalVerdictSha256, run.modelDeliveryEvidenceSha256, run.usageEvidenceSha256,
          run.pricingEvidenceSha256, run.oracleIsolationEvidenceSha256].every(digest) ||
        !Number.isSafeInteger(run.actualInputTokens) || run.actualInputTokens <= 0 ||
        !Number.isSafeInteger(run.actualOutputTokens) || run.actualOutputTokens <= 0 ||
        !Number.isFinite(run.actualCostUsd) || run.actualCostUsd <= 0 ||
        !Number.isSafeInteger(run.latencyMs) || run.latencyMs <= 0) return null;
    }
    const candidate = runs.find((r) => r.kind === "candidate")!;
    const paced = runs.find((r) => r.kind === "paced")!;
    const maximum = runs.find((r) => r.kind === "maximum")!;
    const proof: VideoProfileLiveProof = {
      proofId: "video_live_proof_" + randomUUID().replaceAll("-", ""), driver: target.driver,
      modelId: target.modelId, providerId: target.providerId, capabilitiesSha256: target.capabilitiesSha256,
      reviewerNamespaceSha256: target.reviewerNamespaceSha256,
      oracleIsolationEvidenceSha256: maximum.oracleIsolationEvidenceSha256,
      profile: PACED_VIDEO_REVIEW_PROFILE, validatedAt: now, expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      candidateValidationRunId: candidate.runId, pacedValidationRunId: paced.runId,
      maximumProfileValidationRunId: maximum.runId, sourceSha256: maximum.sourceSha256,
      manifestSha256: maximum.manifestSha256, orderedReceiptSetSha256: maximum.orderedReceiptSetSha256,
      privateOracleCommitmentSha256: maximum.privateOracleCommitmentSha256,
      blindTemporalVerdictSha256: maximum.blindTemporalVerdictSha256,
      modelDeliveryEvidenceSha256: maximum.modelDeliveryEvidenceSha256,
      usageEvidenceSha256: maximum.usageEvidenceSha256, pricingEvidenceSha256: maximum.pricingEvidenceSha256,
      inputTokens: maximum.actualInputTokens, outputTokens: maximum.actualOutputTokens,
      actualCostUsd: maximum.actualCostUsd, latencyMs: maximum.latencyMs, verifiedByUserId: principal.userId,
    };
    if (!validVideoLiveProof(proof, target, now)) return null;
    this.db.prepare("INSERT INTO video_profile_live_validation " +
      "(proof_id,driver,model_id,provider_id,capabilities_sha256,proof) VALUES (?,?,?,?,?,?)")
      .run(proof.proofId, target.driver, target.modelId, target.providerId, target.capabilitiesSha256, JSON.stringify(proof));
    return proof;
  }

  current(target: EvidenceReviewerTarget, now = Date.now()): VideoProfileLiveProof | null {
    const rows = this.db.prepare("SELECT proof FROM video_profile_live_validation WHERE revoked=0 " +
      "AND driver=? AND model_id=? AND provider_id=? AND capabilities_sha256=? ORDER BY rowid DESC")
      .all(target.driver, target.modelId, target.providerId, target.capabilitiesSha256) as Array<{ proof: string }>;
    for (const row of rows) {
      const proof = JSON.parse(row.proof) as VideoProfileLiveProof;
      if (validVideoLiveProof(proof, target, now)) return proof;
    }
    return null;
  }

  /** Unrevoked proofs inside their validity window, for readiness only. Admission still checks
   * each proof against its exact current reviewer target with validVideoLiveProof. */
  unexpired(now = Date.now()): VideoProfileLiveProof[] {
    return (this.db.prepare("SELECT proof FROM video_profile_live_validation WHERE revoked=0 ORDER BY rowid DESC").all() as Array<{ proof: string }>)
      .map((row) => JSON.parse(row.proof) as VideoProfileLiveProof)
      .filter((proof) => proof.validatedAt <= now && proof.expiresAt > now);
  }

  list(principal: AuthPrincipal, now = Date.now()): VideoLiveValidationSummary[] | null {
    if (!administrator(principal)) return null;
    return (this.db.prepare("SELECT proof, revoked FROM video_profile_live_validation ORDER BY rowid DESC LIMIT 100").all() as
      Array<{ proof: string; revoked: number }>).map((row) => {
      const proof = JSON.parse(row.proof) as VideoProfileLiveProof;
      return { proofId: proof.proofId, driver: proof.driver, modelId: proof.modelId, providerId: proof.providerId,
        capabilitiesSha256: proof.capabilitiesSha256, validatedAt: proof.validatedAt, expiresAt: proof.expiresAt,
        verifiedByUserId: proof.verifiedByUserId, revoked: row.revoked !== 0, expired: proof.expiresAt <= now };
    });
  }

  revoke(principal: AuthPrincipal, proofId: string): boolean {
    return administrator(principal) &&
      Number(this.db.prepare("UPDATE video_profile_live_validation SET revoked=1 WHERE proof_id=? AND revoked=0")
        .run(proofId).changes) === 1;
  }
}
