import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAMPAIGN_EVIDENCE_PROVIDER_DISCLOSURE_REVISION, CAMPAIGN_SESSION_ARTIFACT_DISCLOSURE_REVISION,
  DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PACED_VIDEO_REVIEW_CONTRACT_ID, PROTOCOL_VERSION,
  campaignSessionArtifactDestinationId, type ControlPlaneToRunner, type MediaReviewDispatch, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "../../../control-plane/src/db.js";
import { mintCampaignEvidenceAuthority } from "../../../control-plane/src/evidence-authority.js";
import { hostingEvidenceAuthorityDisclosures } from "../../../control-plane/src/hosting-evidence-disclosures.js";
import { composeHostingVideoEvidence } from "../../../control-plane/src/hosting-video-evidence.js";
import type { Hub } from "../../../control-plane/src/hub.js";
import type { AgentPrincipal, HumanPrincipal } from "../../../control-plane/src/identity.js";
import { resolveOrchestratorCampaignPolicy } from "../../../control-plane/src/orchestrator-settings.js";
import { SessionsService, normalizeWorkflowDecisionSnapshot } from "../../../control-plane/src/sessions.js";
import type { VideoPreparationResult } from "../../../control-plane/src/video-evidence-preparation.js";
import { syntheticInspectedVideoRuns, syntheticMediaReviewerAttestation,
  syntheticVideoReviewerTarget } from "../../../control-plane/src/video-live-validation-test-fixture.js";

export const VIDEO_RUNNER_ID = "delegated-video-evidence-e2e";
const WORKSPACE_ID = "video-workspace";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** The synthetic runner's catalog: one Claude Code installation declaring the paced contract and a
 * synthetic media-only reviewer attestation. It names no real executable and attests nothing. */
export function delegatedVideoRunner(workspacePath: string): RunnerMetadata {
  return { runnerId: VIDEO_RUNNER_ID, hostname: "test-host", os: "linux", version: "e2e",
    workspaces: [{ id: WORKSPACE_ID, name: "Video Evidence E2E", path: workspacePath }],
    agents: [{ id: "claude", name: "Video Reviewer", command: "claude", args: [], env: {}, driver: "claude-code",
      available: true, context: { kind: "native" },
      capabilities: { models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5", default: true, inputModalities: ["text", "image"] }],
        effortLevels: ["high"], slashCommands: [], supportsImages: true, supportsApprovals: true, imageToolResults: true,
        permissionModes: ["default", "orchestrator"], pacedVideoReviewContract: { id: PACED_VIDEO_REVIEW_CONTRACT_ID, revision: 1 },
        mediaReviewerAttestation: syntheticMediaReviewerAttestation("claude") } }] };
}

/** Seed a real control-plane database with an Orchestrator-owned video evidence decision, a
 * disclosed synthetic live proof, and a review the Orchestrator prepared and dispatched. The browser
 * job has no isolated ffmpeg, so this seed alone derives frames with a disclosed synthetic decoder;
 * the live process then serves every route after dispatch from the stored frames. */
export async function seedDelegatedVideoEvidence(databasePath: string, workspacePath: string) {
  const db = ControlPlaneDb.open(databasePath);
  try {
    const now = Date.now();
    const local = db.localIdentityContext();
    const human: HumanPrincipal = { ...local, kind: "human", actorId: local.userId };
    const audience = { organizationId: local.organizationId, owner: { kind: "user" as const, userId: local.userId } };
    db.registerRunner(delegatedVideoRunner(workspacePath), now, PROTOCOL_VERSION);
    db.setUsageRateTable(new Map([["claude-opus-5-5", { inputCostPerToken: 0.000001, outputCostPerToken: 0.000001,
      cacheReadCostPerToken: 0.000001, cacheCreationCostPerToken: 0.000001 }]]));
    const sent: ControlPlaneToRunner[] = [];
    const hub = new Proxy({ isRunnerOnline: () => true, runnerProtocolVersion: () => PROTOCOL_VERSION,
      sendToRunner: (_: string, message: ControlPlaneToRunner) => { sent.push(message); return true; } }, {
      get(target, key: string) { return key in target ? target[key as keyof typeof target] : () => undefined; },
    }) as unknown as Hub;
    const disclosures = hostingEvidenceAuthorityDisclosures({
      organizationExists: (organizationId) => db.listOrganizationIds().includes(organizationId), listRunners: () => db.listRunners() });
    const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
    policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [1321], revision: 1, authorizedByUserId: local.userId, authorizedAt: now };
    policy.issueNumbers = [1321];
    db.createSession({ id: "video-orchestrator", runnerId: VIDEO_RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "claude",
      title: "Video Orchestrator", useWorktree: false, driver: "claude-code", config: { model: "claude-opus-5-5", permissionMode: "orchestrator" },
      scope: audience, creationActor: "human", role: "orchestrator", orchestratorPolicy: policy,
      parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } }, now });
    db.updateSessionStatus("video-orchestrator", "running", now);
    const decoder = { candidate: async (): Promise<VideoPreparationResult> => ({ ok: false, code: "decoder_unavailable", reason: "Unused.", retryable: false }),
      paced: async (bytes: Buffer, mediaType: "video/webm" | "video/mp4"): Promise<VideoPreparationResult> => {
        const images = Array.from({ length: 130 }, (_, i) => Buffer.from(`synthetic decoded frame ${i}`));
        const manifest = { schemaVersion: 1 as const, purpose: "offline_preparation_only" as const,
          profile: "paced-silent-video-preparation-v1" as const, sourceSha256: sha(bytes), sourceSizeBytes: bytes.length,
          sourceMediaType: mediaType, width: 1280, height: 720, durationUs: 130 * 33_334,
          frames: images.map((image, index) => ({ index, ptsUs: index * 33_334, durationUs: 33_334, sha256: sha(image), sizeBytes: image.length })),
          segments: [{ index: 0, firstFrame: 0, frameCount: 130, startUs: 0, endUs: 130 * 33_334 }] };
        return { ok: true, manifest, manifestSha256: sha(JSON.stringify(manifest)), images };
      } };
    const video = composeHostingVideoEvidence(db, { decoder });
    const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, undefined, undefined, undefined, undefined, undefined,
      undefined, false, undefined, video.preparedMediaRuntime, video.workflowVideoApprovals, disclosures, video.operatorValidationPermits,
      video.preparedMediaActiveStops);
    video.attach(svc, hub);
    const control = svc.setCampaignControl("video-orchestrator", { mode: "full_control", objective: "Review #1321 video evidence",
      operations: ["ui_evidence_approval"], delegatablePolicyIds: [], budgetAuthority: { version: 1, accounting: "managed_workers_only",
        unpriced: "stop", toolCalls: 1000, costUsd: 200, concurrency: 3 } }, 1, human);
    if (!control.ok) throw new Error(control.error ?? "campaign control failed");
    const rootPolicy = db.getSession("video-orchestrator")!.orchestratorPolicy!;
    if (rootPolicy.control?.mode !== "full_control") throw new Error("no Full Control boundary");
    const boundary = rootPolicy.control.boundary;
    const evidence = mintCampaignEvidenceAuthority(human, boundary, "video-orchestrator", {
      destinationConfigurationId: campaignSessionArtifactDestinationId(local.organizationId),
      destinationDisclosureRevision: CAMPAIGN_SESSION_ARTIFACT_DISCLOSURE_REVISION,
      providers: [{ providerId: "claude-code", disclosureRevision: CAMPAIGN_EVIDENCE_PROVIDER_DISCLOSURE_REVISION,
        reviewers: [{ driver: "claude-code", modelId: "claude-opus-5-5" }] }] }, disclosures);
    if (!evidence) throw new Error("evidence authority mint failed");
    boundary.evidenceAuthority = evidence;
    // Fixture-only Human boundary composition, as the control-plane integration harness does.
    db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='video-orchestrator'").run(JSON.stringify(rootPolicy));
    db.createSession({ id: "video-child", parentSessionId: "video-orchestrator", runnerId: VIDEO_RUNNER_ID, workspaceId: WORKSPACE_ID,
      agentId: "claude", title: "Video Evidence Child", useWorktree: false, driver: "claude-code", scope: audience,
      config: { model: "claude-opus-5-5", costBudgetUsd: 2, maxToolCalls: 10 }, now });
    db.updateSessionStatus("video-child", "running", now);
    const source = readFileSync(fileURLToPath(new URL("../../../control-plane/test-fixtures/video-preparation-paced.webm", import.meta.url)));
    db.createWorkflowArtifactBytes({ artifactId: "video-source", sessionId: "video-child", kind: "video", name: "Walkthrough.webm",
      mimeType: "video/webm", encoding: "base64", sha256: sha(source), sizeBytes: source.length, createdBy: { kind: "agent", id: "video-child" },
      metadata: { purpose: "session_attachment" }, createdAt: now }, source);
    const normalized = normalizeWorkflowDecisionSnapshot({ category: "ui_evidence_approval",
      evidence: [{ evidenceId: "walkthrough", artifactId: "video-source", sha256: sha(source), mediaType: "video/webm" }] });
    if (!normalized.ok || !normalized.data) throw new Error("snapshot normalization failed");
    if (!db.createWorkflowDecision({ requestId: "delegated-video-evidence", occurrenceId: "video-gate", sessionId: "video-child",
      controllingSessionId: "video-orchestrator", category: "ui_evidence_approval", resourceKey: "delegated-video-evidence",
      resourceSnapshot: normalized.data, resourceDigest: sha(JSON.stringify(normalized.data)), policyRevision: boundary.revision,
      authority: "orchestrator", createdAt: now })) throw new Error("decision creation failed");
    const target = syntheticVideoReviewerTarget({ runnerId: VIDEO_RUNNER_ID, agentId: "claude", driver: "claude-code", modelId: "claude-opus-5-5",
      protocolVersion: PROTOCOL_VERSION, contract: { id: PACED_VIDEO_REVIEW_CONTRACT_ID, revision: 1 },
      attestation: syntheticMediaReviewerAttestation("claude"), providerId: "claude-code" });
    if (!video.liveValidation.recordInspectedRuns(human, target, syntheticInspectedVideoRuns(target, human.userId), now - 1_000)) {
      throw new Error("disclosed synthetic proof was refused");
    }
    const owner: AgentPrincipal = { kind: "agent", actorId: "video-orchestrator", credentialSessionId: "video-orchestrator",
      orchestrator: true, organizationId: local.organizationId, delegatedScope: audience };
    const prepared = await video.delegated.prepare(owner, { childSessionId: "video-child", occurrenceId: "video-gate", evidenceId: "walkthrough" });
    video.delegated.close();
    if (!prepared.ok || !("status" in prepared) || prepared.status !== "dispatched") throw new Error("preparation refused: " + JSON.stringify(prepared));
    const dispatch = sent.flatMap((message) => message.type === "media_review_dispatch" ? [message.dispatch] : [])[0] as MediaReviewDispatch | undefined;
    if (!dispatch) throw new Error("no media review dispatch was sent");
    const parentToken = "delegated-video-evidence-parent-token";
    if (!db.setAgentControlCredential("video-orchestrator", VIDEO_RUNNER_ID, sha(parentToken), now)) throw new Error("parent credential failed");
    const runnerToken = "delegated-video-evidence-runner-token";
    db.issueRunnerCredential({ credentialId: "delegated-video-evidence-runner", runnerId: VIDEO_RUNNER_ID,
      organizationId: local.organizationId, ownerKind: "organization", ownerId: local.organizationId, label: "Delegated Video Evidence E2E",
      tokenHash: sha(runnerToken), createdByUserId: local.userId, now, expiresAt: now + 60 * 60 * 1000 });
    return { parentId: "video-orchestrator", childId: "video-child", occurrenceId: "video-gate", evidenceId: "walkthrough",
      parentToken, runnerToken, dispatch, frameMarker: Buffer.from("synthetic decoded frame 64").toString("base64") };
  } finally {
    db.close();
  }
}
