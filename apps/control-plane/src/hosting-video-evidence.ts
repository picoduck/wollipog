import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { supportsPacedVideoReviewPeer, type PacedVideoReviewPeerContract, type VideoReviewerProofState,
  type VideoReviewSettingsStatus } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { VideoLaunchCertification } from "./campaign-launch-admission.js";
import { DelegatedVideoReviews, installationReviewerTarget, mediaReviewerAttestationSha256, mediaReviewerInstallationGaps,
  mediaReviewerInstallations, VIDEO_REVIEWER_EFFORT,
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
  // Human validation permits (#1321): the trusted scope port resolves every fact from current
  // records and the server's own derivation; only an authenticated Human route mints or starts one.
  const operatorValidationPermits = new OperatorVideoValidationPermits(db.raw(),
    { current: (identity, subject) => delegated.validationScope(identity, subject) }, options.clock);
  delegated.useValidation(operatorValidationPermits, runtime);

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

  /** The certified reviewer a Full Control launch rooted on this runner could use: an attested
   * installation there whose exact target, under the provider a launch envelope discloses for the
   * Claude Code harness, holds a current Human-recorded proof. Admission still rechecks everything. */
  const launchCertification = (runnerId: string, now = Date.now()): VideoLaunchCertification | null => {
    const expiries = mediaReviewerInstallations(db, runnerId).flatMap((installation) => {
      const proof = liveValidation.current(installationReviewerTarget(installation, "claude-code"), now);
      return proof ? [proof.expiresAt] : [];
    });
    return expiries.length ? { reviewer: { driver: "claude-code", model: VIDEO_REVIEWER_MODEL, effort: VIDEO_REVIEWER_EFFORT },
      proofExpiresAt: Math.max(...expiries), adaptersReady: delegated.ready } : null;
  };

  /** Settings view for an owner/admin: each machine's installation gap, or for an attested
   * installation the newest proof for its exact attestation (certified, expired, revoked, missing). */
  const settingsStatus = (principal: HumanPrincipal, now = Date.now()): VideoReviewSettingsStatus | null => {
    if (!administrator(principal)) return null;
    const installations = mediaReviewerInstallations(db);
    const machines = mediaReviewerInstallationGaps(db).map((machine) => {
      const installation = machine.gap ? undefined : installations.find((candidate) =>
        candidate.runnerId === machine.runnerId && candidate.agentId === machine.agentId);
      if (!installation) return { ...machine, proof: null };
      const target = installationReviewerTarget(installation, "claude-code");
      const current = liveValidation.current(target, now);
      const newest = liveValidation.newest(target);
      const proof: VideoReviewerProofState = current
        ? { state: "certified", proofId: current.proofId, validatedAt: current.validatedAt, expiresAt: current.expiresAt }
        : !newest ? { state: "missing" }
        : newest.revoked ? { state: "revoked", proofId: newest.proof.proofId }
        : newest.proof.expiresAt <= now ? { state: "expired", proofId: newest.proof.proofId, expiresAt: newest.proof.expiresAt }
        : { state: "missing" };
      return { ...machine, proof };
    });
    return { readiness: readiness(now), reviewer: { driver: "claude-code", model: VIDEO_REVIEWER_MODEL, effort: VIDEO_REVIEWER_EFFORT },
      mediaTypes: ["video/mp4", "video/webm"], machines };
  };

  const attach = (sessions: DelegatedVideoSessions, hub: DelegatedVideoHub) => delegated.attach(sessions, hub, reviewService);

  return { liveValidation, reviewStore, runtime, workflowVideoApprovals, preparedMediaActiveStops, reviewService, delegated,
    preparedMediaRuntime: delegated.runtimeResolver, operatorValidationPermits, pacedPeers, readiness, launchCertification, settingsStatus, attach,
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
    requestPrincipal: deps.requestPrincipal, unavailable: (sessionId, route) => {
      const readiness = video.readiness();
      // A current Human validation run's reviewer reaches the media routes before any proof exists:
      // that run is how the first proof is made. Owner routes and every other gap still refuse.
      if (readiness.available || (route === "reviewer" && readiness.code === "live_validation" &&
        video.delegated.ready && video.delegated.isValidationReviewer(sessionId))) return null;
      return readiness;
    } });

  app.get("/api/video-evidence/live-validations", async (req, reply) => {
    const principal = deps.requestPrincipal(req);
    const proofs = principal ? video.liveValidation.list(principal) : null;
    if (!administrator(principal) || !proofs) return reply.code(403).send({ error: ADMIN_ONLY });
    reply.header("cache-control", "private, no-store");
    return { proofs, readiness: video.readiness() };
  });

  app.get("/api/video-evidence/review-status", async (req, reply) => {
    const principal = deps.requestPrincipal(req);
    const status = administrator(principal) ? video.settingsStatus(principal) : null;
    if (!status) return reply.code(403).send({ error: ADMIN_ONLY });
    reply.header("cache-control", "private, no-store");
    return status;
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

  // ---- Human validation permits and runs (#1321). Owners and admins only; never a Session credential. ----
  const human = (req: FastifyRequest, reply: FastifyReply): HumanPrincipal | null => {
    const principal = deps.requestPrincipal(req);
    if (administrator(principal)) return principal;
    void reply.code(403).send({ error: ADMIN_ONLY });
    return null;
  };
  const answer = (reply: FastifyReply, result: { ok: boolean; code?: string }, success = 200) => {
    reply.header("cache-control", "private, no-store");
    return reply.code(result.ok ? success : result.code === "not_authorized" ? 403 : 409).send(result);
  };
  const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === keys.length &&
    Object.keys(value as object).every((key) => keys.includes(key));
  const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value);

  app.post("/api/video-evidence/validation-permits/preview", async (req, reply) => {
    if (!human(req, reply)) return reply;
    const body = req.body;
    if (!exact(body, ["occurrenceId", "evidenceId", "profile", "privateOracleCommitmentSha256"]) || !id(body.occurrenceId) ||
      !id(body.evidenceId) || typeof body.profile !== "string" || typeof body.privateOracleCommitmentSha256 !== "string") {
      return reply.code(400).send({ error: "An exact occurrence, evidence, profile and oracle commitment are required." });
    }
    return answer(reply, await video.delegated.previewValidation(body as Parameters<typeof video.delegated.previewValidation>[0]));
  });

  app.post("/api/video-evidence/validation-permits", async (req, reply) => {
    const principal = human(req, reply);
    if (!principal) return reply;
    const body = req.body;
    if (!exact(body, ["identity", "subject", "expectedScopeSha256", "expiresAt"])) {
      return reply.code(400).send({ error: "The previewed identity, subject, scope digest and an expiry are required." });
    }
    let permit;
    try { permit = video.operatorValidationPermits.mint(principal, body as Parameters<typeof video.operatorValidationPermits.mint>[1]); }
    catch { permit = null; }
    if (!permit) {
      return answer(reply, { ok: false, code: "invalid_permit" as const,
        error: "The permit was refused: the scope changed since the preview, the expiry is not within an hour, you did not establish this campaign's boundary, or this evidence and profile already had a permit." } as never);
    }
    return answer(reply, { ok: true, permit: { permitId: permit.permitId, scopeSha256: permit.scopeSha256, expiresAt: permit.expiresAt,
      profile: permit.scope.subject.profile } } as never, 201);
  });

  app.post("/api/video-evidence/validation-permits/:permitId/run", async (req, reply) => {
    const principal = human(req, reply);
    if (!principal) return reply;
    return answer(reply, await video.delegated.startValidation(principal, (req.params as { permitId: string }).permitId));
  });

  app.get("/api/video-evidence/validation-permits/:permitId", async (req, reply) => {
    const principal = human(req, reply);
    if (!principal) return reply;
    return answer(reply, video.delegated.validationRun(principal, (req.params as { permitId: string }).permitId));
  });

  app.post("/api/video-evidence/validation-permits/:permitId/revoke", async (req, reply) => {
    const principal = human(req, reply);
    if (!principal) return reply;
    let revoked = false;
    try { revoked = video.operatorValidationPermits.revoke(principal, (req.params as { permitId: string }).permitId); } catch { revoked = false; }
    return answer(reply, revoked ? { ok: true } : { ok: false, code: "no_current_permit",
      error: "No unrevoked validation permit minted by you has this identifier." } as never);
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
