import type { FastifyInstance, FastifyRequest } from "fastify";
import { supportsPacedVideoReviewPeer, type PacedVideoReviewPeerContract } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { DelegatedVideoReviews, mediaReviewerAttestationSha256, mediaReviewerInstallations, VIDEO_REVIEWER_EFFORT,
  VIDEO_REVIEWER_MODEL, type DelegatedVideoHub, type DelegatedVideoSessions } from "./delegated-video-reviews.js";
import { EvidenceReviewService } from "./evidence-review-service.js";
import type { EvidenceReviewerTarget } from "./evidence-review-worker.js";
import { PERSONAL_ORGANIZATION_ID, type AuthPrincipal, type HumanPrincipal } from "./identity.js";
import { OperatorVideoValidationPermits } from "./operator-video-validation.js";
import { PreparedMediaActiveStops } from "./prepared-media-active-stops.js";
import { createControlPlaneVideoReviewStore } from "./video-evidence-artifacts.js";
import { registerVideoEvidenceReviewRoutes } from "./video-evidence-review-routes.js";
import { VideoEvidenceRuntime, type VideoReviewDecoder } from "./video-evidence-runtime.js";
import { VideoLiveValidationRegistry, type InspectedVideoValidationRun } from "./video-live-validation.js";
import { WorkflowVideoEvidenceApprovals } from "./workflow-video-evidence-approvals.js";

/** Why delegated video review is unavailable, checked in this order. Readiness reports available
 * only when an attested reviewer installation has a current Human-inspected live proof and the
 * adapters are attached to Sessions; every admission still rechecks its own exact target. */
export type VideoReviewUnavailableCode = "no_paced_video_peer" | "live_validation" | "reviewer_unavailable";
export type VideoReviewReadiness = { available: true } | { available: false; code: VideoReviewUnavailableCode; reason: string };

/** A registered installation advertising the paced video review contract at a supporting protocol. */
export interface PacedVideoPeer {
  runnerId: string;
  agentId: string;
  driver: string;
  models: string[];
  protocolVersion: number;
  contract: PacedVideoReviewPeerContract;
}

const REASONS: Record<VideoReviewUnavailableCode, string> = {
  no_paced_video_peer: "No registered runner installation advertises the paced video review contract, so video evidence stays with the Human.",
  live_validation: "No current Human-inspected live validation proof covers an attested media-only reviewer installation, so video evidence stays with the Human.",
  reviewer_unavailable: "This control plane's video review adapters are not attached yet, so video evidence stays with the Human.",
};
const refusal = (code: VideoReviewUnavailableCode): VideoReviewReadiness => ({ available: false, code, reason: REASONS[code] });

/** The production composition of delegated video evidence review (#1321). Construction creates the
 * durable schema; nothing is admitted until a Human records a live proof for an attested reviewer.
 * `attach` connects the Session service and runner hub once they exist. */
export function composeHostingVideoEvidence(db: ControlPlaneDb, options: {
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Test seams only; hosting passes none and uses the isolated native decoder and real timers. */
  decoder?: VideoReviewDecoder;
  clock?: () => number;
  schedule?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
} = {}) {
  const liveValidation = new VideoLiveValidationRegistry(db.raw());
  const reviewStore = createControlPlaneVideoReviewStore(db);
  const delegated = new DelegatedVideoReviews(db, reviewStore, liveValidation, options.log, options.clock, options.schedule);
  const runtime = new VideoEvidenceRuntime(reviewStore, delegated.runtimeAccess, options.clock, options.decoder);
  const workflowVideoApprovals = new WorkflowVideoEvidenceApprovals(db, runtime, delegated.gateAccess);
  const preparedMediaActiveStops = new PreparedMediaActiveStops(db.raw(), delegated.activeStopPorts);
  const reviewService = new EvidenceReviewService(runtime, reviewStore, delegated.serviceAdapter);
  // Human validation permits need a trusted scope adapter that no hosting route provides yet, so
  // none can be minted here; the store exists so materialization can refuse unknown permits.
  const operatorValidationPermits = new OperatorVideoValidationPermits(db.raw(), { current: () => null });

  const pacedPeers = (): PacedVideoPeer[] => db.listRunners().flatMap((runner) => runner.agents
    .filter((agent) => supportsPacedVideoReviewPeer(runner.protocolVersion, agent.capabilities?.pacedVideoReviewContract))
    .map((agent) => ({ runnerId: runner.runnerId, agentId: agent.id, driver: agent.driver ?? "acp",
      models: (agent.capabilities?.models ?? []).map((model) => model.id), protocolVersion: runner.protocolVersion!,
      contract: agent.capabilities!.pacedVideoReviewContract as PacedVideoReviewPeerContract })));

  const readiness = (now = Date.now()): VideoReviewReadiness => {
    if (!pacedPeers().length) return refusal("no_paced_video_peer");
    const installations = mediaReviewerInstallations(db);
    if (!liveValidation.unexpired(now).some((proof) => proof.driver === "claude-code" && proof.modelId === VIDEO_REVIEWER_MODEL &&
      proof.effort === VIDEO_REVIEWER_EFFORT && installations.some((installation) =>
        proof.capabilitiesSha256 === mediaReviewerAttestationSha256(installation.attestation) &&
        proof.reviewerNamespaceSha256 === installation.attestation.namespacePolicySha256))) return refusal("live_validation");
    return delegated.ready ? { available: true } : refusal("reviewer_unavailable");
  };

  const attach = (sessions: DelegatedVideoSessions, hub: DelegatedVideoHub) => delegated.attach(sessions, hub, reviewService);

  return { liveValidation, reviewStore, runtime, workflowVideoApprovals, preparedMediaActiveStops, reviewService, delegated,
    preparedMediaRuntime: delegated.runtimeResolver, operatorValidationPermits, pacedPeers, readiness, attach,
    reviewerInstallations: () => mediaReviewerInstallations(db) };
}
export type HostingVideoEvidence = ReturnType<typeof composeHostingVideoEvidence>;

/** Proofs certify an installation's reviewer for the whole control plane, so, like the hosting gate
 * for every global resource, only owners and admins of the personal organization manage them. */
const administrator = (principal: AuthPrincipal | null): principal is HumanPrincipal =>
  principal?.kind === "human" && (principal.role === "owner" || principal.role === "admin") &&
  principal.organizationId === PERSONAL_ORGANIZATION_ID;
const ADMIN_ONLY = "Live video validation is installation-wide, so only an owner or admin of the personal organization manages it.";

/** Agent review routes behind the readiness gate, plus the Human-only live validation ingress. */
export function registerHostingVideoEvidenceRoutes(app: FastifyInstance, deps: {
  video: HostingVideoEvidence;
  requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
}): void {
  const { video } = deps;
  registerVideoEvidenceReviewRoutes(app, { service: video.reviewService, owner: video.delegated,
    requestPrincipal: deps.requestPrincipal, unavailable: () => {
      const readiness = video.readiness();
      return readiness.available ? null : readiness;
    } });

  app.get("/api/video-evidence/live-validations", async (req, reply) => {
    const principal = deps.requestPrincipal(req);
    const proofs = principal ? video.liveValidation.list(principal) : null;
    if (!administrator(principal) || !proofs) return reply.code(403).send({ error: ADMIN_ONLY });
    reply.header("cache-control", "private, no-store");
    return { proofs, readiness: video.readiness() };
  });

  app.post("/api/video-evidence/live-validations", async (req, reply) => {
    const principal = deps.requestPrincipal(req);
    if (!administrator(principal)) return reply.code(403).send({ error: ADMIN_ONLY });
    const body = req.body as { target?: EvidenceReviewerTarget; runs?: InspectedVideoValidationRun[] } | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 ||
      !body.target || typeof body.target !== "object" || !Array.isArray(body.runs)) {
      return reply.code(400).send({ error: "An exact reviewer target and its three inspected validation runs are required." });
    }
    const target = body.target;
    // The proof may name only an installation that currently advertises the contract it certifies.
    // Contracts compare by validated field, never by serialization, so key order cannot matter.
    const contract = supportsPacedVideoReviewPeer(target.runnerProtocolVersion, target.pacedVideoReviewContract)
      ? target.pacedVideoReviewContract as PacedVideoReviewPeerContract : null;
    if (!contract || !video.pacedPeers().some((peer) => peer.runnerId === target.runnerId && peer.agentId === target.agentId &&
      peer.driver === target.driver && peer.models.includes(target.modelId) && peer.protocolVersion === target.runnerProtocolVersion &&
      peer.contract.id === contract.id && peer.contract.revision === contract.revision)) {
      return reply.code(409).send({ code: "no_paced_video_peer",
        error: "No registered installation advertises the paced video review contract for this exact reviewer target." });
    }
    // The proof certifies one attested reviewer: the runner's current media-only attestation and
    // namespace, at the certified model and effort. A changed attestation needs a new proof.
    const installation = video.reviewerInstallations().find((candidate) =>
      candidate.runnerId === target.runnerId && candidate.agentId === target.agentId);
    if (!installation || target.driver !== "claude-code" || target.modelId !== VIDEO_REVIEWER_MODEL ||
      target.effort !== VIDEO_REVIEWER_EFFORT || target.capabilitiesSha256 !== mediaReviewerAttestationSha256(installation.attestation) ||
      target.reviewerNamespaceSha256 !== installation.attestation.namespacePolicySha256) {
      return reply.code(409).send({ code: "attestation_mismatch",
        error: `The target must name the runner's current media-only reviewer attestation at ${VIDEO_REVIEWER_MODEL}, effort ${VIDEO_REVIEWER_EFFORT}.` });
    }
    let proof;
    try { proof = video.liveValidation.recordInspectedRuns(principal, target, body.runs); } catch { proof = null; }
    if (!proof) {
      return reply.code(409).send({ code: "invalid_validation",
        error: "The inspected runs do not prove the candidate, paced and maximum profiles for this exact reviewer target." });
    }
    return reply.code(201).send({ proof: video.liveValidation.list(principal)!.find((item) => item.proofId === proof.proofId) });
  });

  app.post("/api/video-evidence/live-validations/:proofId/revoke", async (req, reply) => {
    const principal = deps.requestPrincipal(req);
    if (!administrator(principal)) return reply.code(403).send({ error: ADMIN_ONLY });
    const { proofId } = req.params as { proofId: string };
    if (!video.liveValidation.revoke(principal, proofId)) {
      return reply.code(409).send({ code: "no_current_proof", error: "No unrevoked live validation proof has this identifier." });
    }
    return { revoked: true, readiness: video.readiness() };
  });
}
