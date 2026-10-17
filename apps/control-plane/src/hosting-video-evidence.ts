import type { FastifyInstance, FastifyRequest } from "fastify";
import { supportsPacedVideoReviewPeer } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { EvidenceReviewService } from "./evidence-review-service.js";
import type { EvidenceReviewerTarget } from "./evidence-review-worker.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { PreparedMediaActiveStops } from "./prepared-media-active-stops.js";
import { createControlPlaneVideoReviewStore } from "./video-evidence-artifacts.js";
import { registerVideoEvidenceReviewRoutes } from "./video-evidence-review-routes.js";
import { VideoEvidenceRuntime } from "./video-evidence-runtime.js";
import { VideoLiveValidationRegistry, type InspectedVideoValidationRun } from "./video-live-validation.js";
import { WorkflowVideoEvidenceApprovals } from "./workflow-video-evidence-approvals.js";

/** Why delegated video review is unavailable, checked in this order. Hosting has no production
 * reviewer yet, so readiness never reports available: the media-only reviewer launcher and its
 * review adapters are later work (#1321), and each still needs a Human-certified live proof. */
export type VideoReviewUnavailableCode = "no_paced_video_peer" | "live_validation" | "reviewer_unavailable";
export interface VideoReviewReadiness { available: false; code: VideoReviewUnavailableCode; reason: string }

/** A registered installation advertising the paced video review contract at a supporting protocol. */
export interface PacedVideoPeer {
  runnerId: string;
  agentId: string;
  driver: string;
  models: string[];
  protocolVersion: number;
  contract: unknown;
}

const REASONS: Record<VideoReviewUnavailableCode, string> = {
  no_paced_video_peer: "No registered runner installation advertises the paced video review contract, so video evidence stays with the Human.",
  live_validation: "No current Human-inspected live validation proof covers an installation that advertises paced video review, so video evidence stays with the Human.",
  reviewer_unavailable: "This control plane has no media-only reviewer launcher or video review adapters yet, so video evidence stays with the Human.",
};
const refusal = (code: VideoReviewUnavailableCode): VideoReviewReadiness => ({ available: false, code, reason: REASONS[code] });

const inert = (what: string) => () => { throw new Error(`${what} is not available in this control plane.`); };

/** The production composition of the prepared video evidence pieces (#1321). Every port is inert:
 * no binding is current, no gate is available, no source is readable and no runner has registered
 * an owning media Stop handle. Constructing it creates their durable schema and nothing else. */
export function composeHostingVideoEvidence(db: ControlPlaneDb) {
  const liveValidation = new VideoLiveValidationRegistry(db.raw());
  const reviewStore = createControlPlaneVideoReviewStore(db);
  const runtime = new VideoEvidenceRuntime(reviewStore, {
    currentBinding: () => null, normalCompletion: () => false, workerAdmission: () => null, readSource: () => null,
  });
  const workflowVideoApprovals = new WorkflowVideoEvidenceApprovals(db, runtime, {
    available: () => false, decisionCurrent: () => false, linkedReview: () => null,
  });
  const preparedMediaActiveStops = new PreparedMediaActiveStops(db.raw(), {
    current: () => false, send: inert("A media-only owning worker Stop handle"),
  });
  const reviewService = new EvidenceReviewService(runtime, reviewStore, {
    resolvePending: () => null, currentOwner: () => false, reviewerProtocol: () => null, audit: () => {},
    liveProof: (target) => liveValidation.current(target),
  });

  const pacedPeers = (): PacedVideoPeer[] => db.listRunners().flatMap((runner) => runner.agents
    .filter((agent) => supportsPacedVideoReviewPeer(runner.protocolVersion, agent.capabilities?.pacedVideoReviewContract))
    .map((agent) => ({ runnerId: runner.runnerId, agentId: agent.id, driver: agent.driver ?? "acp",
      models: (agent.capabilities?.models ?? []).map((model) => model.id), protocolVersion: runner.protocolVersion!,
      contract: agent.capabilities?.pacedVideoReviewContract })));

  const readiness = (now = Date.now()): VideoReviewReadiness => {
    const peers = pacedPeers();
    if (!peers.length) return refusal("no_paced_video_peer");
    if (!liveValidation.unexpired(now).some((proof) =>
      peers.some((peer) => peer.driver === proof.driver && peer.models.includes(proof.modelId)))) return refusal("live_validation");
    return refusal("reviewer_unavailable");
  };

  return { liveValidation, reviewStore, runtime, workflowVideoApprovals, preparedMediaActiveStops, reviewService, pacedPeers, readiness };
}
export type HostingVideoEvidence = ReturnType<typeof composeHostingVideoEvidence>;

const administrator = (principal: AuthPrincipal | null): principal is HumanPrincipal =>
  principal?.kind === "human" && (principal.role === "owner" || principal.role === "admin");
const ADMIN_ONLY = "Live video validation is recorded and revoked only by an organization owner or admin.";

/** Agent review routes behind the readiness gate, plus the Human-only live validation ingress. */
export function registerHostingVideoEvidenceRoutes(app: FastifyInstance, deps: {
  video: HostingVideoEvidence;
  requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
}): void {
  const { video } = deps;
  registerVideoEvidenceReviewRoutes(app, { service: video.reviewService, requestPrincipal: deps.requestPrincipal,
    unavailable: () => video.readiness() });

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
    if (!video.pacedPeers().some((peer) => peer.runnerId === target.runnerId && peer.agentId === target.agentId &&
      peer.driver === target.driver && peer.models.includes(target.modelId) && peer.protocolVersion === target.runnerProtocolVersion &&
      JSON.stringify(peer.contract) === JSON.stringify(target.pacedVideoReviewContract))) {
      return reply.code(409).send({ code: "no_paced_video_peer",
        error: "No registered installation advertises the paced video review contract for this exact reviewer target." });
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
