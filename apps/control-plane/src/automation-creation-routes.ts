import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AutomationCreationRequest } from "@wollipog/protocol";
import type { AuthPrincipal } from "./identity.js";
import type { AutomationCreationService } from "./automation-creation.js";

export function registerAutomationCreationRoutes(app: FastifyInstance, deps: {
  service: AutomationCreationService;
  requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
}): void {
  const base = "/api/sessions/:id/automation-proposals";
  for (const [method, suffix] of [["POST", ""], ["GET", "/:occurrenceId"], ["POST", "/:occurrenceId/execute"]] as const) {
    app.route({ method, url: base + suffix, handler: async (req, reply) => {
      const { id, occurrenceId } = req.params as { id: string; occurrenceId?: string };
      const principal = deps.requestPrincipal(req);
      if (principal?.kind !== "agent" || principal.credentialSessionId !== id) {
        return reply.code(403).send({ error: "A matching session credential is required" });
      }
      if (occurrenceId !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(occurrenceId)) {
        return reply.code(400).send({ error: "Invalid occurrenceId" });
      }
      reply.header("cache-control", "no-store");
      if (suffix === "") {
        const result = deps.service.request(id, req.body as AutomationCreationRequest, principal);
        req.log.info({ event: "automation_creation_proposed", entryPoint: "session_automation_proposal", requestId: req.id,
          sessionId: id, occurrenceId: result.data?.occurrenceId, status: result.status }, "Automation proposal inspected");
        return reply.code(result.status).send(result.ok ? result.data : { error: result.error });
      }
      if (method === "GET") {
        const result = deps.service.get(id, occurrenceId!, principal);
        return reply.code(result.status).send(result.ok ? result.data : { error: result.error });
      }
      const body = req.body as { resourceDigest?: unknown } | null;
      if (!body || Object.keys(body).some((key) => key !== "resourceDigest") ||
          typeof body.resourceDigest !== "string" || !/^[0-9a-f]{64}$/.test(body.resourceDigest)) {
        return reply.code(400).send({ error: "An exact resourceDigest is required; configuration overrides are not accepted" });
      }
      const result = deps.service.execute(id, occurrenceId!, body.resourceDigest, principal);
      req.log.info({ event: "automation_creation_executed", entryPoint: "session_automation_execute", requestId: req.id,
        sessionId: id, occurrenceId, status: result.status, automationId: result.data?.automationCreationResult?.automationId }, "Automation creation settled");
      return reply.code(result.status).send(result.ok ? result.data : { error: result.error });
    } });
  }
}
