import { WORKFLOW_EVENT_RETENTION_LIMITS, type UpdateWorkflowEventRetentionRequest } from "@wollipog/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { validWorkflowEventRetentionDays, type WorkflowEventRetention } from "./workflow-event-retention.js";
import type { AuthPrincipal } from "./identity.js";
import { canAdministerIdentity } from "./identity.js";

const LIMITS_TEXT = `${WORKFLOW_EVENT_RETENTION_LIMITS.minDays} and ${WORKFLOW_EVENT_RETENTION_LIMITS.maxDays}`;

export function registerWorkflowEventRetentionRoutes(
  app: FastifyInstance,
  retention: WorkflowEventRetention,
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null,
): void {
  /** `?previewDays=N` adds what a threshold of N days would prune, for the confirmation dialog. */
  app.get("/api/workflow-event-retention", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "workflow event retention is available to organization members only" });
    }
    const rawPreview = (request.query as { previewDays?: unknown } | undefined)?.previewDays;
    const previewDays = rawPreview === undefined ? undefined : Number(rawPreview);
    if (previewDays !== undefined && (typeof rawPreview !== "string" || !/^\d+$/.test(rawPreview) ||
        !validWorkflowEventRetentionDays(previewDays))) {
      return reply.code(400).send({ error: `previewDays must be a whole number of days between ${LIMITS_TEXT}` });
    }
    try {
      return retention.view(principal.organizationId, canAdministerIdentity(principal.role), previewDays);
    } catch (error) {
      request.log.error({ err: error }, "could not load workflow event retention");
      return reply.code(500).send({ error: "could not load workflow event retention" });
    }
  });

  app.put("/api/workflow-event-retention", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    const body = request.body as Partial<UpdateWorkflowEventRetentionRequest> | null;
    const retentionDays = body && typeof body === "object" ? body.retentionDays : undefined;
    if (retentionDays !== null && !validWorkflowEventRetentionDays(retentionDays)) {
      return reply.code(400).send({ error: `retentionDays must be null or a whole number of days between ${LIMITS_TEXT}` });
    }
    try {
      return retention.update(principal.organizationId, retentionDays, principal.userId);
    } catch (error) {
      request.log.error({ err: error }, "could not update workflow event retention");
      return reply.code(500).send({ error: "could not update workflow event retention" });
    }
  });
}
