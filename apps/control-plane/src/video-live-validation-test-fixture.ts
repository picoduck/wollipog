import { createHash } from "node:crypto";
import type { EvidenceReviewerTarget } from "./evidence-review-worker.js";
import type { InspectedVideoValidationRun } from "./video-live-validation.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Synthetic inspected-run metadata for tests only. It is not an actual validated run, delivery
 * receipt or live proof, and nothing in production imports it. */
export function syntheticInspectedVideoRuns(target: EvidenceReviewerTarget, inspectedByUserId: string): InspectedVideoValidationRun[] {
  return ([
    { kind: "candidate", frameCount: 16, width: 640, height: 360, durationUs: 4_000_000 },
    { kind: "paced", frameCount: 360, width: 1280, height: 720, durationUs: 12_000_000 },
    { kind: "maximum", frameCount: 900, width: 1280, height: 720, durationUs: 30_000_000 },
  ] as const).map((profile) => ({
    ...profile, runId: "synthetic_" + profile.kind, target,
    sourceSha256: digest("source " + profile.kind), manifestSha256: digest("manifest " + profile.kind),
    orderedReceiptSetSha256: digest("ordered receipts " + profile.kind), privateOracleCommitmentSha256: digest("private oracle " + profile.kind),
    blindTemporalVerdictSha256: digest("blind verdict " + profile.kind),
    modelDeliveryEvidenceSha256: digest("model visible proof " + profile.kind),
    usageEvidenceSha256: digest("usage " + profile.kind), pricingEvidenceSha256: digest("official pricing " + profile.kind),
    oracleIsolationEvidenceSha256: digest("independent forbidden namespace probes"), oracleNamespaceInaccessibleVerified: true,
    actualInputTokens: 100, actualOutputTokens: 10, actualCostUsd: 0.1, latencyMs: 100,
    allSourceFramesDelivered: true, blindOracleMatched: true, privateOracleExcludedFromReviewerContext: true,
    providerUsageVerified: true, currentOfficialPricingVerified: true, sourceAndArtifactsStillMatch: true,
    inspectedByUserId,
  }));
}

/** A synthetic reviewer target for one registered installation; its digests attest nothing. */
export function syntheticVideoReviewerTarget(installation: { runnerId: string; agentId: string; driver: string; modelId: string;
  protocolVersion: number; contract: unknown }): EvidenceReviewerTarget {
  return { agentId: installation.agentId, driver: installation.driver, modelId: installation.modelId,
    providerId: installation.driver, runnerId: installation.runnerId, runnerProtocolVersion: installation.protocolVersion,
    pacedVideoReviewContract: installation.contract, capabilitiesSha256: digest("synthetic audited capability"),
    auditedAllFrameDelivery: true, reviewerNamespaceSha256: digest("synthetic narrowed namespace"), mediaOnlyNamespaceVerified: true };
}
