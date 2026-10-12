import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "./identity.js";
import { EvidenceReviewService } from "./evidence-review-service.js";
import { VideoReviewRefused, type VideoReviewVerdict } from "./video-evidence-runtime.js";

const text = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const body = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));

/** Registered only with the concrete current authority/admission adapters after foundation,
 * scope and allowance integration. Registration grants no credentials, scope or live proof. */
export function registerVideoEvidenceReviewRoutes(app: FastifyInstance, deps: {
  service: EvidenceReviewService;
  requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
}): void {
  const prefix = "/api/sessions/:id/video-evidence-review";
  const principalFor = (req: FastifyRequest) => {
    const principal = deps.requestPrincipal(req);
    return principal?.kind === "agent" && principal.credentialSessionId === (req.params as { id: string }).id
      ? principal : null;
  };
  app.post(prefix + "/prepare", async (req, reply) => {
    const principal = principalFor(req);
    if (!principal) return reply.code(403).send({ error: "A matching Session credential is required." });
    if (!body(req.body, ["childSessionId", "occurrenceId", "evidenceId"]) ||
      !text(req.body.childSessionId) || !text(req.body.occurrenceId) || !text(req.body.evidenceId)) {
      return reply.code(400).send({ error: "Exact child, occurrence and evidence identifiers are required." });
    }
    reply.header("cache-control", "no-store");
    try {
      const result = await deps.service.prepare(principal, {
        childSessionId: req.body.childSessionId, occurrenceId: req.body.occurrenceId, evidenceId: req.body.evidenceId,
      });
      return reply.code(result.ok ? 200 : result.code === "not_authorized" ? 403 : 409).send(result);
    } catch (error) {
      return reply.code(error instanceof VideoReviewRefused ? 409 : 503).send({
        error: "Video review preparation is unavailable.", code: error instanceof VideoReviewRefused ? error.reason : "unavailable",
      });
    }
  });
  app.post(prefix + "/frame", (req, reply) => {
    const principal = principalFor(req);
    if (!principal) return reply.code(403).send({ error: "A matching reviewer Session credential is required." });
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
  app.post(prefix + "/acknowledge", (req, reply) => {
    const principal = principalFor(req);
    if (!principal) return reply.code(403).send({ error: "A matching reviewer Session credential is required." });
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
    if (!body(req.body, ["reviewId"]) || !text(req.body.reviewId)) {
      return reply.code(400).send({ error: "An exact review identifier is required." });
    }
    reply.header("cache-control", "no-store");
    try { return deps.service.ownerProvenance(principal, req.body.reviewId); }
    catch { return reply.code(409).send({ error: "Current owner authority and complete verified provenance are required." }); }
  });
}
