import { ARCHIVED_HISTORY_RETENTION_LIMITS, type UpdateArchivedHistoryRetentionRequest } from "@wollipog/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { validArchivedHistoryRetentionDays, type ArchivedHistoryRetention } from "./archived-history-retention.js";
import type { AuthPrincipal } from "./identity.js";
import { canAdministerIdentity } from "./identity.js";

const LIMITS_TEXT = `${ARCHIVED_HISTORY_RETENTION_LIMITS.minDays} and ${ARCHIVED_HISTORY_RETENTION_LIMITS.maxDays}`;

export function registerArchivedHistoryRetentionRoutes(
  app: FastifyInstance,
  retention: ArchivedHistoryRetention,
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null,
): void {
  /** `?previewDays=N` adds what a threshold of N days would prune, for the confirmation dialog. */
  app.get("/api/archived-history-retention", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "archived history retention is available to organization members only" });
    }
    const rawPreview = (request.query as { previewDays?: unknown } | undefined)?.previewDays;
    const previewDays = rawPreview === undefined ? undefined : Number(rawPreview);
    if (previewDays !== undefined && (typeof rawPreview !== "string" || !/^\d+$/.test(rawPreview) ||
        !validArchivedHistoryRetentionDays(previewDays))) {
      return reply.code(400).send({ error: `previewDays must be a whole number of days between ${LIMITS_TEXT}` });
    }
    try {
      return retention.view(principal.organizationId, canAdministerIdentity(principal.role), previewDays);
    } catch (error) {
      request.log.error({ err: error }, "could not load archived history retention");
      return reply.code(500).send({ error: "could not load archived history retention" });
    }
  });

  app.put("/api/archived-history-retention", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    const body = request.body as Partial<UpdateArchivedHistoryRetentionRequest> | null;
    const retentionDays = body && typeof body === "object" ? body.retentionDays : undefined;
    if (retentionDays !== null && !validArchivedHistoryRetentionDays(retentionDays)) {
      return reply.code(400).send({ error: `retentionDays must be null or a whole number of days between ${LIMITS_TEXT}` });
    }
    try {
      return retention.update(principal.organizationId, retentionDays, principal.userId);
    } catch (error) {
      request.log.error({ err: error }, "could not update archived history retention");
      return reply.code(500).send({ error: "could not update archived history retention" });
    }
  });
}
