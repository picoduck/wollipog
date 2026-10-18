import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "./identity.js";
import { EvidenceReviewService } from "./evidence-review-service.js";
import { VIDEO_REVIEW_BATCH, VideoReviewRefused, type VideoReviewVerdict } from "./video-evidence-runtime.js";

const text = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const body = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));

/** The owner-facing coordinator: it materializes, derives and dispatches the reviewer itself and
 * reports pending, withheld or refused states. Without it the routes use the bare service. */
export interface VideoEvidenceReviewOwner {
  prepare(principal: AuthPrincipal, request: { childSessionId: string; occurrenceId: string; evidenceId: string }):
    Promise<{ ok: true } | { ok: false; code: string }>;
  provenance(principal: AuthPrincipal, reviewId: string): { ok: true } | { ok: false; code: string };
}

/** Registration grants no credentials, scope or live proof. While `unavailable` reports a reason,
 * every authenticated call is refused with it before any body is read or service is reached. */
export function registerVideoEvidenceReviewRoutes(app: FastifyInstance, deps: {
  service: EvidenceReviewService;
  owner?: VideoEvidenceReviewOwner;
  requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
  /** `route` is "owner" for prepare and provenance, "reviewer" for the media and verdict methods. */
  unavailable?(sessionId: string, route: "owner" | "reviewer"): { code: string; reason: string } | null;
}): void {
  const prefix = "/api/sessions/:id/video-evidence-review";
  // A refusal carries its reason in `error`, which agent tools show verbatim, so a repair
  // exception's next step reaches the Orchestrator intact and not as a truncated raw body.
  const ownerResult = <T extends { ok: boolean }>(result: T) => !result.ok && "reason" in result && typeof result.reason === "string"
    ? { ...result, error: result.reason } : result;
  const refused = (reply: FastifyReply, principal: AuthPrincipal, route: "owner" | "reviewer" = "reviewer") => {
    const refusal = deps.unavailable?.(principal.kind === "agent" ? principal.credentialSessionId ?? "" : "", route);
    return refusal ? reply.code(409).send({ error: refusal.reason, code: refusal.code }) : null;
  };
  const principalFor = (req: FastifyRequest) => {
    const principal = deps.requestPrincipal(req);
    return principal?.kind === "agent" && principal.credentialSessionId === (req.params as { id: string }).id
      ? principal : null;
  };
  app.post(prefix + "/prepare", async (req, reply) => {
    const principal = principalFor(req);
    if (!principal) return reply.code(403).send({ error: "A matching Session credential is required." });
    const refusal = refused(reply, principal, "owner");
    if (refusal) return refusal;
    if (!body(req.body, ["childSessionId", "occurrenceId", "evidenceId"]) ||
      !text(req.body.childSessionId) || !text(req.body.occurrenceId) || !text(req.body.evidenceId)) {
      return reply.code(400).send({ error: "Exact child, occurrence and evidence identifiers are required." });
    }
    reply.header("cache-control", "no-store");
    try {
      const request = { childSessionId: req.body.childSessionId, occurrenceId: req.body.occurrenceId, evidenceId: req.body.evidenceId };
      const result = deps.owner ? await deps.owner.prepare(principal, request) : await deps.service.prepare(principal, request);
      return reply.code(result.ok ? 200 : result.code === "not_authorized" ? 403 : 409).send(ownerResult(result));
    } catch (error) {
      return reply.code(error instanceof VideoReviewRefused ? 409 : 503).send({
        error: "Video review preparation is unavailable.", code: error instanceof VideoReviewRefused ? error.reason : "unavailable",
      });
    }
  });
  app.post(prefix + "/frame", (req, reply) => {
    const principal = principalFor(req);
    if (!principal) return reply.code(403).send({ error: "A matching reviewer Session credential is required." });
    const refusal = refused(reply, principal);
    if (refusal) return refusal;
    if (!body(req.body, ["reviewId", "index"]) || !text(req.body.reviewId) ||
      !Number.isSafeInteger(req.body.index) || Number(req.body.index) < 0 || Number(req.body.index) >= 900) {
      return reply.code(400).send({ error: "A bounded review and source-frame index are required." });
    }
    reply.header("cache-control", "no-store");
    try {
      const result = deps.service.deliver(principal, req.body.reviewId, Number(req.body.index));
      // Only this authenticated media response carries bytes. Audit/projection ports get metadata.
      return { receipt: result.receipt, mimeType: result.mimeType, sizeBytes: result.bytes.length,
        data: result.bytes.toString("base64") };
    } catch {
      return reply.code(409).send({ error: "This credential has no current grant for this exact source frame." });
    }
  });
  app.post(prefix + "/frames", (req, reply) => {
    const principal = principalFor(req);
    if (!principal) return reply.code(403).send({ error: "A matching reviewer Session credential is required." });
    const refusal = refused(reply, principal);
    if (refusal) return refusal;
    // `end` (exclusive) keeps a batch inside the reviewer's current fresh-context delivery window.
    if (!(body(req.body, ["reviewId", "index"]) || body(req.body, ["reviewId", "index", "end"])) || !text(req.body.reviewId) ||
      !Number.isSafeInteger(req.body.index) || Number(req.body.index) < 0 || Number(req.body.index) >= 900 ||
      req.body.end !== undefined && (!Number.isSafeInteger(req.body.end) || Number(req.body.end) <= Number(req.body.index) ||
        Number(req.body.end) > 900)) {
      return reply.code(400).send({ error: "A bounded review and source-frame index are required." });
    }
    reply.header("cache-control", "no-store");
    try {
      const result = deps.service.deliverBatch(principal, req.body.reviewId, Number(req.body.index),
        req.body.end === undefined ? undefined : Number(req.body.end));
      return { deliveries: result.deliveries.map((delivery) => ({
        receipt: delivery.receipt, mimeType: delivery.mimeType, sizeBytes: delivery.bytes.length,
        data: delivery.bytes.toString("base64"),
      })), nextIndex: result.nextIndex, frameCount: result.frameCount };
    } catch { return reply.code(409).send({ error: "This credential has no current grant for this consecutive frame window." }); }
  });
  app.post(prefix + "/acknowledge-frames", (req, reply) => {
    const principal = principalFor(req);
    if (!principal) return reply.code(403).send({ error: "A matching reviewer Session credential is required." });
    const refusal = refused(reply, principal);
    if (refusal) return refusal;
    if (!body(req.body, ["reviewId", "receipts"]) || !text(req.body.reviewId) ||
      !Array.isArray(req.body.receipts) || !req.body.receipts.length || req.body.receipts.length > VIDEO_REVIEW_BATCH.frames ||
      req.body.receipts.some((r: unknown) => !body(r, ["receiptId", "sha256"]) || !text(r.receiptId) ||
        typeof r.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(r.sha256))) {
      return reply.code(400).send({ error: "A bounded consecutive set of exact receipts is required." });
    }
    reply.header("cache-control", "no-store");
    try {
      deps.service.acknowledgeBatch(principal, req.body.reviewId, req.body.receipts as Array<{ receiptId: string; sha256: string }>);
      return { acknowledged: true };
    } catch { return reply.code(409).send({ error: "The complete receipt window is stale, mismatched or unavailable." }); }
  });
  app.post(prefix + "/acknowledge", (req, reply) => {
    const principal = principalFor(req);
    if (!principal) return reply.code(403).send({ error: "A matching reviewer Session credential is required." });
    const refusal = refused(reply, principal);
    if (refusal) return refusal;
    if (!body(req.body, ["reviewId", "receiptId", "sha256"]) || !text(req.body.reviewId) || !text(req.body.receiptId) ||
      typeof req.body.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(req.body.sha256)) {
      return reply.code(400).send({ error: "An exact review receipt and digest are required." });
    }
    reply.header("cache-control", "no-store");
    try {
      deps.service.acknowledge(principal, req.body.reviewId, req.body.receiptId, req.body.sha256);
      return { acknowledged: true };
    } catch { return reply.code(409).send({ error: "The receipt is stale, mismatched or unavailable." }); }
  });
  app.post(prefix + "/verdict", (req, reply) => {
    const principal = principalFor(req);
    if (!principal) return reply.code(403).send({ error: "A matching reviewer Session credential is required." });
    const refusal = refused(reply, principal);
    if (refusal) return refusal;
    if (!body(req.body, ["reviewId", "report"]) || !text(req.body.reviewId) ||
      !body(req.body.report, ["outcome", "criteria", "rationale"]) ||
      !["accept", "reject"].includes(String(req.body.report.outcome)) ||
      !Array.isArray(req.body.report.criteria) || req.body.report.criteria.length > 64 ||
      !text(req.body.report.rationale, 16_000)) {
      return reply.code(400).send({ error: "A bounded criterion verdict is required." });
    }
    reply.header("cache-control", "no-store");
    try {
      return deps.service.verdict(principal, req.body.reviewId,
        req.body.report as unknown as Pick<VideoReviewVerdict, "outcome" | "criteria" | "rationale">);
    } catch { return reply.code(409).send({ error: "Complete current receipts and matching criteria are required." }); }
  });
  app.post(prefix + "/provenance", (req, reply) => {
    const principal = principalFor(req);
    if (!principal) return reply.code(403).send({ error: "A matching decision-owner Session credential is required." });
    const refusal = refused(reply, principal, "owner");
    if (refusal) return refusal;
    if (!body(req.body, ["reviewId"]) || !text(req.body.reviewId)) {
      return reply.code(400).send({ error: "An exact review identifier is required." });
    }
    reply.header("cache-control", "no-store");
    try {
      if (!deps.owner) return deps.service.ownerProvenance(principal, req.body.reviewId);
      const result = deps.owner.provenance(principal, req.body.reviewId);
      return reply.code(result.ok ? 200 : result.code === "not_authorized" ? 403 : 409).send(ownerResult(result));
    }
    catch { return reply.code(409).send({ error: "Current owner authority and complete verified provenance are required." }); }
  });
}
