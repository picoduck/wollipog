import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "./identity.js";
import {
  OrchestratorSettingsInputError,
  OrchestratorSettingsUnavailableError,
  type OrchestratorSettings,
} from "./orchestrator-settings.js";

export function registerOrchestratorSettingsRoutes(
  app: FastifyInstance,
  settings: OrchestratorSettings,
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null,
): void {
  app.get("/api/orchestrator-settings", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "Orchestrator defaults are available to signed-in users only" });
    }
    return reply.header("cache-control", "private, no-store").send(settings.view(principal));
  });

  app.put("/api/orchestrator-settings", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "only an authenticated human may change Orchestrator defaults" });
    }
    try {
      return reply.header("cache-control", "private, no-store").send(settings.update(principal, request.body));
    } catch (error) {
      if (error instanceof OrchestratorSettingsInputError) return reply.code(400).send({ error: error.message });
      if (error instanceof OrchestratorSettingsUnavailableError) return reply.code(409).send({ error: error.message });
      request.log.error({ err: error }, "could not update Orchestrator defaults");
      return reply.code(500).send({ error: "could not update Orchestrator defaults" });
    }
  });
}
