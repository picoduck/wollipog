import { createHash } from "node:crypto";
import { mediaReviewerAttestationBody, PACED_VIDEO_REVIEW_WINDOW_LIMITS, type ClaudeMediaReviewerAttestation } from "@wollipog/protocol";
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

/** A synthetic runner attestation shaped like PR B's media-only Claude Code reviewer. It names no
 * real executable or namespace and attests nothing; tests use it to exercise digest binding. */
export function syntheticMediaReviewerAttestation(agentId: string, cliVersion = "synthetic"): ClaudeMediaReviewerAttestation {
  return { profile: "claude-code-media-only-v1", harness: "claude-code", agentId, cliVersion,
    executableSha256: digest("synthetic executable " + cliVersion), namespacePolicySha256: digest("synthetic narrowed namespace"),
    tools: ["review_video_evidence_frame", "submit_video_evidence_verdict"], credential: "dedicated_api_key",
    windowLimitsRevision: PACED_VIDEO_REVIEW_WINDOW_LIMITS.revision };
}

/** A synthetic reviewer target for one registered installation; its digests attest nothing. With an
 * attestation, the target names that attestation's digest and namespace as hosting requires. */
export function syntheticVideoReviewerTarget(installation: { runnerId: string; agentId: string; driver: string; modelId: string;
  protocolVersion: number; contract: unknown; attestation?: ClaudeMediaReviewerAttestation; providerId?: string }): EvidenceReviewerTarget {
  return { agentId: installation.agentId, driver: installation.driver, modelId: installation.modelId, effort: "high",
    providerId: installation.providerId ?? installation.driver, runnerId: installation.runnerId, runnerProtocolVersion: installation.protocolVersion,
    pacedVideoReviewContract: installation.contract,
    capabilitiesSha256: installation.attestation ? digest(mediaReviewerAttestationBody(installation.attestation)) : digest("synthetic audited capability"),
    auditedAllFrameDelivery: true, mediaOnlyNamespaceVerified: true,
    reviewerNamespaceSha256: installation.attestation?.namespacePolicySha256 ?? digest("synthetic narrowed namespace") };
}
