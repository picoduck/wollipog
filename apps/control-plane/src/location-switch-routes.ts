import type { FastifyInstance, FastifyRequest } from "fastify";
import type { LocationSwitchRequest } from "@wollipog/protocol";
import type { AuthPrincipal } from "./identity.js";
import type { LocationSwitchService } from "./location-switch.js";

/** A session's own Location switch (#4138): request, read and execute, with its own credential only. */
export function registerLocationSwitchRoutes(app: FastifyInstance, deps: {
  service: LocationSwitchService;
  requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
}): void {
  const base = "/api/sessions/:id/location-switch-requests";
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
        const result = await deps.service.request(id, req.body as LocationSwitchRequest, principal);
        req.log.info({ event: "location_switch_requested", requestId: req.id, sessionId: id,
          occurrenceId: result.data?.occurrenceId, status: result.status }, "Location switch request inspected");
        return reply.code(result.status).send(result.ok ? result.data : { error: result.error });
      }
      if (method === "GET") {
        const result = deps.service.get(id, occurrenceId!, principal);
        return reply.code(result.status).send(result.ok ? result.data : { error: result.error });
      }
      const body = req.body as { resourceDigest?: unknown } | null;
      if (!body || Object.keys(body).some((key) => key !== "resourceDigest") ||
          typeof body.resourceDigest !== "string" || !/^[0-9a-f]{64}$/.test(body.resourceDigest)) {
        return reply.code(400).send({ error: "An exact resourceDigest is required; the Location comes only from the approval" });
      }
      const result = await deps.service.execute(id, occurrenceId!, body.resourceDigest, principal);
      req.log.info({ event: "location_switch_executed", requestId: req.id, sessionId: id, occurrenceId, status: result.status,
        continuedIn: result.data?.locationSwitchResult?.sessionId }, "Location switch settled");
      return reply.code(result.status).send(result.ok ? result.data : { error: result.error });
    } });
  }
}
